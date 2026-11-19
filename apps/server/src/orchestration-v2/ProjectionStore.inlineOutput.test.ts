import { assert, it } from "@effect/vitest";
import { EventId, ThreadId, TurnItemId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import * as ProjectionStore from "./ProjectionStore.ts";
import { layerTest } from "./ProjectionStore.testkit.ts";

it.effect("recomputes inline output when an existing turn item changes", () =>
  Effect.gen(function* () {
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const threadId = ThreadId.make("thread:inline-update");
    const now = yield* DateTime.now;
    const base = {
      id: TurnItemId.make("item:inline-update"),
      threadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      status: "completed" as const,
      title: null,
      startedAt: now,
      completedAt: now,
      updatedAt: now,
    };
    const flag = () => sql<{ readonly inline_work_output: number }>`SELECT inline_work_output
      FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${base.id}`;
    for (const [index, toolName, expected] of [
      [0, "plain", 0],
      [1, "goat.delegate_task", 1],
      [2, "plain", 0],
    ] as const) {
      yield* store.apply({
        id: EventId.make(`event:inline-update:${index}`),
        type: "turn-item.updated",
        threadId,
        occurredAt: now,
        payload: { ...base, type: "dynamic_tool", toolName, input: {}, output: {} },
      });
      assert.equal((yield* flag())[0]?.inline_work_output, expected);
    }
    yield* store.apply({
      id: EventId.make("event:inline-update:type"),
      type: "turn-item.updated",
      threadId,
      occurredAt: now,
      payload: { ...base, type: "command_execution", input: "echo", output: "htmlRender" },
    });
    assert.equal((yield* flag())[0]?.inline_work_output, 0);
  }).pipe(Effect.provide(layerTest)),
);
