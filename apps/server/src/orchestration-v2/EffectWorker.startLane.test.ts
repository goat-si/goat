// @effect-diagnostics nodeBuiltinImport:off
import * as NodeOS from "node:os";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProviderSessionId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as HostPressureMonitor from "../fleet/pressure/HostPressureMonitor.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import { layerEffectOutboxProvided } from "./FoundationPersistence.testkit.ts";

it.effect("start lane applies critical pressure to each serialized claim", () =>
  Effect.gen(function* () {
    const level = yield* Ref.make<"ok" | "critical">("ok");
    const pressure = Layer.mock(HostPressureMonitor.HostPressureMonitor)({
      current: Ref.get(level).pipe(
        Effect.map((value) => ({
          level: value,
          since: "2026-01-01T00:00:00.000Z",
          reasons: [],
          loadPerCore: null,
          eventLoopDelayMs: null,
        })),
      ),
    });
    const outboxLayer = EffectOutbox.layer.pipe(
      Layer.provide(pressure),
      Layer.provide(SqlitePersistence.layerMemory),
    );
    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const workerId = "start-lane-pressure-test";
      const start = (n: number) => ({
        id: `start-lane:${n}`,
        commandId: CommandId.make(`start-lane:${n}`),
        threadId: ThreadId.make(`start-lane:${n}`),
        request: { type: "provider-turn.start" as const, runId: RunId.make(`start-lane:${n}`) },
      });
      yield* outbox.enqueue([start(1), start(2), start(3)]);
      const first = yield* outbox.claimNext({ workerId, leaseDurationMs: 30_000 });
      const second = yield* outbox.claimNext({ workerId, leaseDurationMs: 30_000 });
      assert.equal(Option.getOrThrow(first).id, "start-lane:1");
      assert.equal(Option.getOrThrow(second).id, "start-lane:2");
      yield* Ref.set(level, "critical");
      assert.isTrue(Option.isNone(yield* outbox.claimNext({ workerId, leaseDurationMs: 30_000 })));
      yield* outbox.succeed({ workerId, effectId: "start-lane:1" });
      assert.isTrue(Option.isNone(yield* outbox.claimNext({ workerId, leaseDurationMs: 30_000 })));
      assert.deepInclude(Option.getOrThrow(yield* outbox.get("start-lane:3")), {
        status: "pending",
        attemptCount: 0,
      });
      yield* outbox.succeed({ workerId, effectId: "start-lane:2" });
      assert.equal(
        Option.getOrThrow(yield* outbox.claimNext({ workerId, leaseDurationMs: 30_000 })).id,
        "start-lane:3",
      );
    }).pipe(Effect.provide(outboxLayer));
  }),
);

it.effect("start lane wakes its worker when general workers are idle", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const idle = yield* Deferred.make<void>();
    const started = yield* Deferred.make<void>();
    const workerLayer = EffectWorker.layer.pipe(
      Layer.provide(
        Layer.merge(
          Layer.succeed(EffectOutbox.EffectOutboxV2, {
            ...outbox,
            awaitAvailable: Deferred.succeed(idle, undefined).pipe(
              Effect.andThen(outbox.awaitAvailable),
            ),
          }),
          Layer.mock(EffectWorker.OrchestrationEffectExecutorV2)({
            execute: () => Deferred.succeed(started, undefined).pipe(Effect.asVoid),
          }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      yield* EffectWorker.runDaemonWithOptions({ concurrency: 1 }).pipe(Effect.forkScoped);
      yield* Deferred.await(idle);
      yield* outbox.enqueue([
        {
          id: "start-lane:wake",
          commandId: CommandId.make("start-lane:wake"),
          threadId: ThreadId.make("start-lane:wake"),
          request: { type: "provider-turn.start", runId: RunId.make("start-lane:wake") },
        },
      ]);
      yield* outbox.notifyAvailable();
      yield* Deferred.await(started);
      yield* outbox.awaitSettled("start-lane:wake");
    }).pipe(Effect.provide(workerLayer), Effect.scoped);
  }).pipe(Effect.provide(Layer.fresh(layerEffectOutboxProvided))),
);

it.effect("start lane falls back to the core budget without a pressure monitor", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const capacity = Math.max(2, Math.floor(NodeOS.availableParallelism() / 2));
    const workerId = "start-lane-fallback";
    yield* outbox.enqueue(
      Array.from({ length: capacity + 1 }, (_, n) => ({
        id: `start-lane:fallback:${String(n).padStart(4, "0")}`,
        commandId: CommandId.make(`start-lane:fallback:${n}`),
        threadId: ThreadId.make(`start-lane:fallback:${n}`),
        request: {
          type: "provider-turn.start" as const,
          runId: RunId.make(`start-lane:fallback:${n}`),
        },
      })),
    );
    for (let n = 0; n < capacity; n++) {
      assert.isTrue(Option.isSome(yield* outbox.claimNext({ workerId, leaseDurationMs: 30_000 })));
    }
    assert.isTrue(Option.isNone(yield* outbox.claimNext({ workerId, leaseDurationMs: 30_000 })));
    assert.deepInclude(
      Option.getOrThrow(
        yield* outbox.get(`start-lane:fallback:${String(capacity).padStart(4, "0")}`),
      ),
      { status: "pending", attemptCount: 0 },
    );
  }).pipe(Effect.provide(Layer.fresh(layerEffectOutboxProvided))),
);

it.effect("start lane serializes pressure samples with competing claims", () =>
  Effect.gen(function* () {
    const samples = yield* Ref.make(0);
    const monitor = Layer.mock(HostPressureMonitor.HostPressureMonitor)({
      current: Ref.updateAndGet(samples, (n) => n + 1).pipe(
        Effect.map((n) => ({
          level: n === 1 ? ("ok" as const) : ("critical" as const),
          since: "2026-01-01T00:00:00.000Z",
          reasons: [],
          loadPerCore: null,
          eventLoopDelayMs: null,
        })),
      ),
    });
    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      yield* outbox.enqueue(
        [1, 2, 3].map((n) => ({
          id: `start-lane:sample:${n}`,
          commandId: CommandId.make(`start-lane:sample:${n}`),
          threadId: ThreadId.make(`start-lane:sample:${n}`),
          request: {
            type: "provider-turn.start" as const,
            runId: RunId.make(`start-lane:sample:${n}`),
          },
        })),
      );
      const results = yield* Effect.forEach(
        [1, 2, 3],
        (n) => outbox.claimNext({ workerId: `sample:${n}`, leaseDurationMs: 30_000 }),
        { concurrency: "unbounded" },
      );
      assert.equal(results.filter(Option.isSome).length, 1);
      assert.equal(yield* Ref.get(samples), 3);
    }).pipe(
      Effect.provide(
        EffectOutbox.layer.pipe(
          Layer.provide(monitor),
          Layer.provide(SqlitePersistence.layerMemory),
        ),
      ),
    );
  }),
);

it.effect("start lane production stores composition applies critical capacity", () =>
  Effect.gen(function* () {
    const monitor = Layer.mock(HostPressureMonitor.HostPressureMonitor)({
      current: Effect.succeed({
        level: "critical",
        since: "2026-01-01T00:00:00.000Z",
        reasons: [],
        loadPerCore: null,
        eventLoopDelayMs: null,
      }),
    });
    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const workerId = "start-lane-composition";
      yield* outbox.enqueue(
        [1, 2, 3].map((n) => ({
          id: `start-lane:composition:${n}`,
          commandId: CommandId.make(`start-lane:composition:${n}`),
          threadId: ThreadId.make(`start-lane:composition:${n}`),
          request: {
            type: "provider-turn.start" as const,
            runId: RunId.make(`start-lane:composition:${n}`),
          },
        })),
      );
      assert.equal(
        Option.getOrThrow(yield* outbox.claimNext({ workerId, leaseDurationMs: 30_000 })).id,
        "start-lane:composition:1",
      );
      assert.isTrue(Option.isNone(yield* outbox.claimNext({ workerId, leaseDurationMs: 30_000 })));
      assert.deepInclude(Option.getOrThrow(yield* outbox.get("start-lane:composition:2")), {
        status: "pending",
        attemptCount: 0,
      });
    }).pipe(
      Effect.provide(
        RuntimeLayer.layerStores.pipe(
          Layer.provide(monitor),
          Layer.provide(SqlitePersistence.layerMemory),
        ),
      ),
    );
  }),
);

it.effect("start lane preserves FIFO while a steer can claim when it is full", () =>
  Effect.gen(function* () {
    const monitor = Layer.mock(HostPressureMonitor.HostPressureMonitor)({
      current: Effect.succeed({
        level: "critical",
        since: "2026-01-01T00:00:00.000Z",
        reasons: [],
        loadPerCore: null,
        eventLoopDelayMs: null,
      }),
    });
    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const workerId = "start-lane-fifo";
      yield* outbox.enqueue([
        ...[1, 2, 3].map((n) => ({
          id: `start-lane:fifo:${n}`,
          commandId: CommandId.make(`start-lane:fifo:${n}`),
          threadId: ThreadId.make(`start-lane:fifo:${n}`),
          request: {
            type: "provider-turn.start" as const,
            runId: RunId.make(`start-lane:fifo:${n}`),
          },
        })),
        {
          id: "start-lane:fifo:steer",
          commandId: CommandId.make("start-lane:fifo:steer"),
          threadId: ThreadId.make("start-lane:fifo:steer"),
          request: {
            type: "provider-turn.steer",
            providerSessionId: ProviderSessionId.make("session:fifo"),
            providerThreadId: ProviderThreadId.make("thread:fifo"),
            providerTurnId: ProviderTurnId.make("turn:fifo"),
            messageId: MessageId.make("message:fifo"),
          },
        },
      ]);
      assert.equal(
        Option.getOrThrow(yield* outbox.claimNext({ workerId, leaseDurationMs: 30_000 })).id,
        "start-lane:fifo:1",
      );
      assert.equal(
        Option.getOrThrow(yield* outbox.claimNext({ workerId, leaseDurationMs: 30_000 })).id,
        "start-lane:fifo:steer",
      );
      assert.isTrue(Option.isNone(yield* outbox.claimNext({ workerId, leaseDurationMs: 30_000 })));
      assert.deepInclude(Option.getOrThrow(yield* outbox.get("start-lane:fifo:2")), {
        status: "pending",
        attemptCount: 0,
      });
      assert.deepInclude(Option.getOrThrow(yield* outbox.get("start-lane:fifo:3")), {
        status: "pending",
        attemptCount: 0,
      });
      yield* outbox.succeed({ workerId, effectId: "start-lane:fifo:1" });
      assert.equal(
        Option.getOrThrow(yield* outbox.claimNext({ workerId, leaseDurationMs: 30_000 })).id,
        "start-lane:fifo:2",
      );
    }).pipe(
      Effect.provide(
        EffectOutbox.layer.pipe(
          Layer.provide(monitor),
          Layer.provide(SqlitePersistence.layerMemory),
        ),
      ),
    );
  }),
);

it.effect("start lane daemon wakes each pending start under sustained critical pressure", () =>
  Effect.gen(function* () {
    const entered = yield* Queue.unbounded<string>();
    const releases = yield* Effect.forEach([1, 2, 3], () => Deferred.make<void>());
    const monitor = Layer.mock(HostPressureMonitor.HostPressureMonitor)({
      current: Effect.succeed({
        level: "critical",
        since: "2026-01-01T00:00:00.000Z",
        reasons: [],
        loadPerCore: null,
        eventLoopDelayMs: null,
      }),
    });
    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const workerLayer = EffectWorker.layer.pipe(
        Layer.provide(
          Layer.merge(
            Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
            Layer.mock(EffectWorker.OrchestrationEffectExecutorV2)({
              execute: (effect) => {
                const n = Number(effect.id.at(-1)) - 1;
                const gate = releases[n];
                return gate === undefined
                  ? Effect.die("missing start gate")
                  : Queue.offer(entered, effect.id).pipe(Effect.andThen(Deferred.await(gate)));
              },
            }),
          ),
        ),
      );
      yield* outbox.enqueue(
        [1, 2, 3].map((n) => ({
          id: `start-lane:daemon:${n}`,
          commandId: CommandId.make(`start-lane:daemon:${n}`),
          threadId: ThreadId.make(`start-lane:daemon:${n}`),
          request: {
            type: "provider-turn.start" as const,
            runId: RunId.make(`start-lane:daemon:${n}`),
          },
        })),
      );
      yield* Effect.gen(function* () {
        yield* EffectWorker.runDaemonWithOptions({ concurrency: 1 }).pipe(Effect.forkScoped);
        yield* outbox.notifyAvailable(3);
        for (const n of [1, 2, 3]) {
          assert.equal(yield* Queue.take(entered), `start-lane:daemon:${n}`);
          if (n < 3)
            assert.deepInclude(Option.getOrThrow(yield* outbox.get(`start-lane:daemon:${n + 1}`)), {
              status: "pending",
              attemptCount: 0,
            });
          const gate = releases[n - 1];
          if (gate === undefined) return yield* Effect.die("missing start gate");
          yield* Deferred.succeed(gate, undefined);
        }
        yield* outbox.awaitSettled("start-lane:daemon:3");
      }).pipe(Effect.provide(workerLayer), Effect.scoped);
    }).pipe(
      Effect.provide(
        EffectOutbox.layer.pipe(
          Layer.provide(monitor),
          Layer.provide(SqlitePersistence.layerMemory),
        ),
      ),
    );
  }),
);

it.effect("start lane server pressure boundary shares one monitor with the runtime", () =>
  Effect.gen(function* () {
    const constructions = yield* Ref.make(0);
    const reads = yield* Ref.make(0);
    const monitor = Layer.effect(
      HostPressureMonitor.HostPressureMonitor,
      Ref.update(constructions, (n) => n + 1).pipe(
        Effect.as(
          HostPressureMonitor.HostPressureMonitor.of({
            current: Ref.update(reads, (n) => n + 1).pipe(
              Effect.as({
                level: "critical" as const,
                since: "2026-01-01T00:00:00.000Z",
                reasons: [],
                loadPerCore: null,
                eventLoopDelayMs: null,
              }),
            ),
            sample: Effect.succeed({
              level: "critical",
              since: "2026-01-01T00:00:00.000Z",
              reasons: [],
              loadPerCore: null,
              eventLoopDelayMs: null,
            }),
            disk: Stream.empty,
          }),
        ),
      ),
    );
    const productionBoundary = RuntimeLayer.layerStores.pipe(
      RuntimeLayer.provideHostPressure(monitor),
    );
    yield* Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const supplied = yield* HostPressureMonitor.HostPressureMonitor;
      yield* supplied.current;
      yield* outbox.enqueue(
        [1, 2].map((n) => ({
          id: `start-lane:boundary:${n}`,
          commandId: CommandId.make(`start-lane:boundary:${n}`),
          threadId: ThreadId.make(`start-lane:boundary:${n}`),
          request: {
            type: "provider-turn.start" as const,
            runId: RunId.make(`start-lane:boundary:${n}`),
          },
        })),
      );
      assert.isTrue(
        Option.isSome(yield* outbox.claimNext({ workerId: "boundary", leaseDurationMs: 30_000 })),
      );
      assert.isTrue(
        Option.isNone(yield* outbox.claimNext({ workerId: "boundary", leaseDurationMs: 30_000 })),
      );
      assert.equal(yield* Ref.get(constructions), 1);
      assert.equal(yield* Ref.get(reads), 3);
    }).pipe(
      Effect.provide(
        Layer.merge(productionBoundary, monitor).pipe(Layer.provide(SqlitePersistence.layerMemory)),
      ),
    );
  }),
);
