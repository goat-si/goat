import { assert } from "@effect/vitest";
import {
  EventId,
  NodeId,
  RunId,
  TurnItemId,
  type ThreadId,
  type OrchestrationV2ThreadHistoryPage,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { ProjectionStoreV2Shape } from "./ProjectionStore.ts";
import { encodeThreadHistoryCursor } from "./threadHistoryPaging.ts";
import { driver, providerInstanceId } from "./ProjectionStore.testkit.ts";

export const assertHistorySubagent = Effect.fn("assertHistorySubagent")(function* (input: {
  sql: SqlClient.SqlClient;
  projectionStore: ProjectionStoreV2Shape;
  threadId: ThreadId;
  now: DateTime.Utc;
  historyPage: (
    threadId: ThreadId,
    cursor: string,
  ) => Effect.Effect<
    OrchestrationV2ThreadHistoryPage,
    SqlError | Effect.Error<ReturnType<ProjectionStoreV2Shape["getThreadHistoryPage"]>>
  >;
}) {
  const { sql, projectionStore, threadId, now, historyPage } = input;
  // A settled subagent of an old run is outside the window; its page carries its record.
  const subagentId = NodeId.make("node:bounded-sql-history:subagent");
  yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'subagent', payload_json = json_set(payload_json,
          '$.type', 'subagent', '$.subagentId', ${subagentId}, '$.origin', 'provider_native',
          '$.driver', ${driver}, '$.providerInstanceId', ${providerInstanceId},
          '$.childThreadId', json('null'), '$.prompt', 'Look', '$.result', 'Done')
        WHERE thread_id = ${threadId} AND ordinal = 580
      `;
  yield* projectionStore.apply({
    id: EventId.make("event:bounded-sql-history:subagent"),
    type: "subagent.updated",
    threadId,
    nodeId: subagentId,
    driver,
    providerInstanceId,
    occurredAt: now,
    payload: {
      id: subagentId,
      threadId,
      runId: RunId.make("run:bounded-sql-history:580"),
      parentNodeId: NodeId.make("node:bounded-sql-history:580"),
      origin: "provider_native",
      createdBy: "agent",
      driver,
      providerInstanceId,
      providerThreadId: null,
      childThreadId: null,
      nativeTaskRef: null,
      prompt: "Look",
      title: "Old child",
      model: "claude-haiku-4-5-20251001",
      status: "completed",
      result: "Done",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    },
  });
  assert.deepEqual(
    (yield* projectionStore.getThreadSnapshotWindow(threadId, { rowLimit: 76 })).projection
      .subagents,
    [],
  );
  const subagentPage = yield* historyPage(
    threadId,
    encodeThreadHistoryCursor({
      snapshotSequence: 0,
      sourceThreadId: threadId,
      sourceItemId: TurnItemId.make("turn-item:bounded-sql-history:590"),
      position: 589,
    }),
  );
  assert.deepEqual(
    subagentPage.subagents?.map((agent) => [agent.id, agent.model]),
    [[subagentId, "claude-haiku-4-5-20251001"]],
  );
  yield* sql`DELETE FROM orchestration_v2_projection_subagents WHERE subagent_id = ${subagentId}`;
  yield* sql`
        UPDATE orchestration_v2_projection_turn_items
        SET type = 'command_execution', payload_json = json_set(payload_json, '$.type', 'command_execution')
        WHERE thread_id = ${threadId} AND ordinal = 580
      `;
});
