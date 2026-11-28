import {
  OrchestrationV2SubagentJson,
  type OrchestrationV2ProjectedTurnItem,
  type ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { isConversationHistoryItem } from "./threadHistoryPaging.ts";

const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(OrchestrationV2SubagentJson));
const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));

export const historyPageSubagents = Effect.fn("ProjectionStore.historyPageSubagents")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  pageItems: ReadonlyArray<OrchestrationV2ProjectedTurnItem>,
  conversationOnly: boolean | undefined,
  meta: { snapshotSequence: number; nextCursor: string | null; hasMoreHistory: boolean },
) {
  const positioned = pageItems.map((row, position) => ({ ...row, position }));
  const rows = conversationOnly
    ? positioned.filter((row) => isConversationHistoryItem(row.item))
    : positioned;
  const ids = rows.flatMap(({ sourceThreadId, item }) =>
    item.type === "subagent" && sourceThreadId === threadId ? [item.subagentId] : [],
  );
  const payloads =
    ids.length === 0
      ? []
      : yield* sql<{ readonly payload_json: string }>`
    SELECT payload_json FROM orchestration_v2_projection_subagents
    WHERE thread_id = ${threadId}
      AND subagent_id IN (SELECT value FROM json_each(${encodeIds(ids)}))
    ORDER BY COALESCE(started_at, ''), subagent_id ASC
  `;
  const subagents = yield* Effect.forEach(payloads, (row) => decode(row.payload_json));
  return { ...meta, items: rows, ...(subagents.length === 0 ? {} : { subagents }) };
});
