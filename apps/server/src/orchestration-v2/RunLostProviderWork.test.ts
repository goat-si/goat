import { assert, it } from "@effect/vitest";
import { EventId, ProviderInstanceId, type OrchestrationV2Run } from "@goat/contracts";
import type * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { idleThreadProjection, liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as CommandReceipts from "./CommandReceiptStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import { makeLostProviderWork } from "./RunLostProviderWork.ts";
import {
  emptyOpenRunOwnedSubagentProjection,
  type OpenRunOwnedSubagentProjection,
} from "./RunOwnedSubagentProjection.ts";
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

it.effect("rereads a changed child item and settles the remaining work", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const ids = backgroundScenarioIds("lost-child-retry");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const input = {
      ids,
      providerInstanceId,
      childThreadId: ids.childThreadId,
      driver,
      status: "running" as const,
    };
    const subagent = makeRunOwnedSubagentFixture(input);
    const item = makeRunOwnedSubagentTurnItemFixture(input);
    const now = yield* DateTime.now;
    const thread = idleThreadProjection(liveThreadShell(ids.threadId)).thread;
    yield* sink.write({
      events: [
        {
          id: EventId.make("retry-thread"),
          type: "thread.created",
          threadId: ids.threadId,
          occurredAt: now,
          payload: thread,
        },
        {
          id: EventId.make("retry-subagent"),
          type: "subagent.updated",
          threadId: ids.threadId,
          runId: ids.runId,
          occurredAt: now,
          payload: subagent,
        },
        {
          id: EventId.make("retry-item"),
          type: "turn-item.updated",
          threadId: ids.threadId,
          runId: ids.runId,
          occurredAt: now,
          payload: item,
        },
      ],
    });
    const read = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const calls = yield* Ref.make(0);
    const open = yield* Ref.make<OpenRunOwnedSubagentProjection>({
      ...emptyOpenRunOwnedSubagentProjection(),
      subagents: new Map([[subagent.id, subagent]]),
      turnItems: new Map([[subagent.id, item]]),
    });
    let serial = 0;
    const allocator = {
      allocate: { event: () => Effect.sync(() => EventId.make(`retry-generated-${serial++}`)) },
    } as unknown as IdAllocator.IdAllocatorV2["Service"];
    const work = makeLostProviderWork(
      {
        run: { id: ids.runId, threadId: ids.threadId, providerInstanceId } as OrchestrationV2Run,
        loadUnsettledWork: (threadId) =>
          Effect.gen(function* () {
            const current = yield* store.getThreadRecords(threadId, [
              "subagents",
              "nodes",
              "turnItems",
            ]);
            const n = yield* Ref.getAndUpdate(calls, (value) => value + 1);
            if (n === 0) {
              yield* Deferred.succeed(read, undefined);
              yield* Deferred.await(release);
            }
            return current;
          }),
      },
      open,
      yield* Ref.make<ReadonlySet<import("@goat/contracts").TurnItemId>>(new Set()),
      sink,
      allocator,
    );
    const settle = yield* work.endWorkLostAfterRootRun(now).pipe(Effect.forkScoped);
    yield* Deferred.await(read);
    yield* sink.write({
      events: [
        {
          id: EventId.make("retry-change"),
          type: "turn-item.updated",
          threadId: ids.threadId,
          runId: ids.runId,
          occurredAt: now,
          payload: { ...item, title: "newer title" },
        },
      ],
    });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(settle);
    const after = yield* store.getThreadRecords(ids.threadId, ["subagents", "turnItems"]);
    assert.equal(after.subagents[0]?.status, "failed");
    assert.equal(after.turnItems[0]?.status, "failed");
    assert.equal(after.turnItems[0]?.title, "newer title");
    assert.isAtLeast(yield* Ref.get(calls), 2);
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);

it.effect("stops after three conflicting child updates without overwriting", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const store = yield* ProjectionStore.ProjectionStoreV2;
    const ids = backgroundScenarioIds("lost-child-contention");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const input = {
      ids,
      providerInstanceId,
      childThreadId: ids.childThreadId,
      driver,
      status: "running" as const,
    };
    const subagent = makeRunOwnedSubagentFixture(input);
    const item = makeRunOwnedSubagentTurnItemFixture(input);
    const now = yield* DateTime.now;
    const thread = idleThreadProjection(liveThreadShell(ids.threadId)).thread;
    yield* sink.write({
      events: [
        {
          id: EventId.make("retry-thread"),
          type: "thread.created",
          threadId: ids.threadId,
          occurredAt: now,
          payload: thread,
        },
        {
          id: EventId.make("retry-subagent"),
          type: "subagent.updated",
          threadId: ids.threadId,
          runId: ids.runId,
          occurredAt: now,
          payload: subagent,
        },
        {
          id: EventId.make("retry-item"),
          type: "turn-item.updated",
          threadId: ids.threadId,
          runId: ids.runId,
          occurredAt: now,
          payload: item,
        },
      ],
    });
    const reads = yield* Effect.all([
      Deferred.make<void>(),
      Deferred.make<void>(),
      Deferred.make<void>(),
    ]);
    const releases = yield* Effect.all([
      Deferred.make<void>(),
      Deferred.make<void>(),
      Deferred.make<void>(),
    ]);
    const calls = yield* Ref.make(0);
    const open = yield* Ref.make<OpenRunOwnedSubagentProjection>({
      ...emptyOpenRunOwnedSubagentProjection(),
      subagents: new Map([[subagent.id, subagent]]),
      turnItems: new Map([[subagent.id, item]]),
    });
    let serial = 0;
    const allocator = {
      allocate: { event: () => Effect.sync(() => EventId.make(`retry-generated-${serial++}`)) },
    } as unknown as IdAllocator.IdAllocatorV2["Service"];
    const work = makeLostProviderWork(
      {
        run: { id: ids.runId, threadId: ids.threadId, providerInstanceId } as OrchestrationV2Run,
        loadUnsettledWork: (threadId) =>
          Effect.gen(function* () {
            const current = yield* store.getThreadRecords(threadId, [
              "subagents",
              "nodes",
              "turnItems",
            ]);
            const n = yield* Ref.getAndUpdate(calls, (value) => value + 1);
            if (n < 3) {
              yield* Deferred.succeed(reads[n]!, undefined);
              yield* Deferred.await(releases[n]!);
            }
            return current;
          }),
      },
      open,
      yield* Ref.make<ReadonlySet<import("@goat/contracts").TurnItemId>>(new Set()),
      sink,
      allocator,
    );
    const settle = yield* work.endWorkLostAfterRootRun(now).pipe(Effect.forkScoped);
    for (let round = 0; round < 3; round++) {
      yield* Deferred.await(reads[round]!);
      yield* sink.write({
        events: [
          {
            id: EventId.make(`contention-${round}`),
            type: "turn-item.updated",
            threadId: ids.threadId,
            runId: ids.runId,
            occurredAt: now,
            payload: { ...item, title: `round ${round}` },
          },
        ],
      });
      yield* Deferred.succeed(releases[round]!, undefined);
    }
    yield* Fiber.join(settle);
    const after = yield* store.getThreadRecords(ids.threadId, ["subagents", "turnItems"]);
    assert.equal(after.subagents[0]?.status, "running");
    assert.equal(after.turnItems[0]?.status, "running");
    assert.equal(after.turnItems[0]?.title, "round 2");
    assert.equal(yield* Ref.get(calls), 3);
  }).pipe(Effect.provide(layerTest), Effect.scoped),
);
