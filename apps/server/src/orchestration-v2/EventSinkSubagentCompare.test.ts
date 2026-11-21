import { assert, it } from "@effect/vitest";
import { EventId, ProviderInstanceId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as SqlClient from "effect/sql/SqlClient";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CommandReceipts from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  backgroundScenarioIds,
  driver,
  makeRunOwnedSubagentFixture,
  makeRunOwnedSubagentTurnItemFixture,
} from "./RunExecutionService.testkit.ts";

const layerTest = EventSink.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      EventStore.layer,
      ProjectionStore.layer,
      CommandReceipts.layer,
      EffectOutbox.layer,
    ),
  ),
  Layer.provideMerge(SqlitePersistence.layerMemory),
);

it.effect("rejects a stale subagent terminalization after another writer changes it", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const ids = backgroundScenarioIds("subagent-compare");
    const subagent = makeRunOwnedSubagentFixture({
      ids,
      providerInstanceId: ProviderInstanceId.make("codex"),
      childThreadId: ids.childThreadId,
      driver,
      status: "running",
    });
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make("subagent-compare-start"),
          type: "subagent.updated",
          threadId: ids.threadId,
          runId: ids.runId,
          occurredAt: now,
          payload: subagent,
        },
      ],
    });
    assert.isTrue(
      (yield* sink.writeIfSubagentUnchanged({ expected: subagent, events: [] })).committed,
    );
    const stopped = { ...subagent, status: "interrupted" as const };
    yield* sink.write({
      events: [
        {
          id: EventId.make("subagent-compare-stop"),
          type: "subagent.updated",
          threadId: ids.threadId,
          runId: ids.runId,
          occurredAt: now,
          payload: stopped,
        },
      ],
    });
    assert.isFalse(
      (yield* sink.writeIfSubagentUnchanged({ expected: subagent, events: [] })).committed,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rejects a stale bundled child item even if its subagent is unchanged", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const ids = backgroundScenarioIds("child-compare");
    const input = {
      ids,
      providerInstanceId: ProviderInstanceId.make("codex"),
      childThreadId: ids.childThreadId,
      driver,
      status: "running" as const,
    };
    const subagent = makeRunOwnedSubagentFixture(input);
    const item = makeRunOwnedSubagentTurnItemFixture(input);
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make("child-compare-owner"),
          type: "subagent.updated",
          threadId: ids.threadId,
          runId: ids.runId,
          occurredAt: now,
          payload: subagent,
        },
        {
          id: EventId.make("child-compare-item"),
          type: "turn-item.updated",
          threadId: ids.threadId,
          runId: ids.runId,
          occurredAt: now,
          payload: item,
        },
      ],
    });
    yield* sink.write({
      events: [
        {
          id: EventId.make("child-compare-stop"),
          type: "turn-item.updated",
          threadId: ids.threadId,
          runId: ids.runId,
          occurredAt: now,
          payload: { ...item, status: "interrupted" },
        },
      ],
    });
    assert.isFalse(
      (yield* sink.writeIfSubagentUnchanged({ expected: subagent, items: [item], events: [] }))
        .committed,
    );
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a concurrent terminal item survives run finalization and the run commit proceeds", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const sql = yield* SqlClient.SqlClient;
    const ids = backgroundScenarioIds("root-atomic-compare");
    const item = makeRunOwnedSubagentTurnItemFixture({
      ids,
      providerInstanceId: ProviderInstanceId.make("codex"),
      childThreadId: ids.childThreadId,
      driver,
      status: "running",
    });
    const otherItem = { ...item, id: ids.childItemId, ordinal: 2 };
    const now = yield* DateTime.now;
    const payload = JSON.stringify({ activeAttemptId: ids.attemptId });
    yield* sql`INSERT INTO orchestration_v2_projection_runs (run_id, thread_id, ordinal, provider, status, requested_at, payload_json) VALUES (${ids.runId}, ${ids.threadId}, 1, 'codex', 'running', '2026-01-01', ${payload})`;
    yield* sink.write({
      events: [
        {
          id: EventId.make("root-atomic-start"),
          type: "turn-item.updated",
          threadId: ids.threadId,
          runId: ids.runId,
          occurredAt: now,
          payload: item,
        },
        {
          id: EventId.make("root-atomic-other-start"),
          type: "turn-item.updated",
          threadId: ids.threadId,
          runId: ids.runId,
          occurredAt: now,
          payload: otherItem,
        },
      ],
    });
    const ready = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const thread = idleThreadProjection(liveThreadShell(ids.childThreadId)).thread;
    const finalization = yield* Effect.gen(function* () {
      yield* Deferred.succeed(ready, undefined);
      yield* Deferred.await(release);
      return yield* sink.writeIfRunCurrent({
        threadId: ids.threadId,
        runId: ids.runId,
        activeAttemptId: ids.attemptId,
        expectedStatus: "running",
        expectedTurnItems: [
          { ...item, ordinal: 1_000_001 },
          { ...otherItem, ordinal: 1_000_002 },
        ],
        events: [
          {
            id: EventId.make("root-atomic-stale"),
            type: "turn-item.updated",
            threadId: ids.threadId,
            runId: ids.runId,
            occurredAt: now,
            payload: { ...item, status: "interrupted" },
          },
          {
            id: EventId.make("root-atomic-other-end"),
            type: "turn-item.updated",
            threadId: ids.threadId,
            runId: ids.runId,
            occurredAt: now,
            payload: { ...otherItem, status: "interrupted" },
          },
          {
            id: EventId.make("root-atomic-marker"),
            type: "thread.created",
            threadId: thread.id,
            occurredAt: now,
            payload: thread,
          },
        ],
      });
    }).pipe(Effect.forkScoped);
    yield* Deferred.await(ready);
    yield* sink.write({
      events: [
        {
          id: EventId.make("root-atomic-completed"),
          type: "turn-item.updated",
          threadId: ids.threadId,
          runId: ids.runId,
          occurredAt: now,
          payload: { ...item, status: "completed" },
        },
      ],
    });
    yield* Deferred.succeed(release, undefined);
    const result = yield* Fiber.join(finalization);
    assert.isTrue(result.committed);
    assert.equal(result.storedEvents.length, 2);
    const rows = yield* sql<{
      readonly status: string;
    }>`SELECT status FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${item.id}`;
    assert.equal(rows[0]?.status, "completed");
    const otherRows = yield* sql<{
      readonly status: string;
    }>`SELECT status FROM orchestration_v2_projection_turn_items WHERE turn_item_id = ${otherItem.id}`;
    assert.equal(otherRows[0]?.status, "interrupted");
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);
