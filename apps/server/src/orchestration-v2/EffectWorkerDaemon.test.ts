import { assert, it } from "@effect/vitest";
import { CheckpointScopeId, CommandId, RunId, ThreadId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import { layerEffectOutboxProvided } from "./FoundationPersistence.testkit.ts";

const capture = (key: string, id: string) => ({
  id: `${key}:${id}`,
  commandId: CommandId.make(`${key}:${id}`),
  threadId: ThreadId.make(`${key}:${id}`),
  request: {
    type: "checkpoint.capture" as const,
    runId: RunId.make(`${key}:${id}`),
    scopeId: CheckpointScopeId.make(`${key}:${id}`),
  },
});

const workerLayer = (
  outbox: EffectOutbox.EffectOutboxV2["Service"],
  execute: EffectWorker.OrchestrationEffectExecutorV2["Service"]["execute"],
) =>
  EffectWorker.layer.pipe(
    Layer.provide(
      Layer.merge(
        Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
        Layer.mock(EffectWorker.OrchestrationEffectExecutorV2)({ execute }),
      ),
    ),
  );

it.effect("stopping the daemon interrupts its in-flight executions together", () =>
  Effect.gen(function* () {
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const key = "daemon:parallel-stop";
    const ids = ["a", "b"] as const;
    const started = { a: yield* Deferred.make<void>(), b: yield* Deferred.make<void>() };
    const interrupted = { a: yield* Deferred.make<void>(), b: yield* Deferred.make<void>() };
    const sawOther = { a: false, b: false };
    const layer = workerLayer(outbox, (effect) => {
      const self = effect.id.endsWith(":a") ? "a" : "b";
      const other = self === "a" ? "b" : "a";
      return Deferred.succeed(started[self], undefined).pipe(
        Effect.andThen(Effect.never),
        // Each teardown waits a bounded time for the other's; a sequential stop times one out.
        Effect.onInterrupt(() =>
          Deferred.succeed(interrupted[self], undefined).pipe(
            Effect.andThen(
              Deferred.await(interrupted[other]).pipe(Effect.timeoutOption("1 minute")),
            ),
            Effect.map((seen) => {
              sawOther[self] = Option.isSome(seen);
            }),
          ),
        ),
      );
    });
    yield* outbox.enqueue(ids.map((id) => capture(key, id)));
    yield* Effect.gen(function* () {
      const daemon = yield* EffectWorker.runDaemonWithOptions({ concurrency: 2 }).pipe(
        Effect.forkChild,
      );
      yield* Deferred.await(started.a);
      yield* Deferred.await(started.b);
      const stop = yield* Fiber.interrupt(daemon).pipe(
        Effect.timeoutOption("1 hour"),
        Effect.forkChild,
      );
      yield* TestClock.adjust("1 hour");
      assert.isTrue(Option.isSome(yield* Fiber.join(stop)), "the daemon never stopped");
      assert.deepEqual(
        sawOther,
        { a: true, b: true },
        "the daemon stopped its executions one at a time",
      );
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(Layer.fresh(layerEffectOutboxProvided))),
);

it.effect(
  "a hung general effect detaches; another thread runs, its own thread waits, then it settles",
  () =>
    Effect.gen(function* () {
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const key = "daemon:general-detach";
      const hung = capture(key, "hung");
      const sameThread = { ...capture(key, "same"), threadId: hung.threadId };
      const other = capture(key, "other");
      const hungStarted = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const ran = { same: yield* Deferred.make<void>(), other: yield* Deferred.make<void>() };
      const layer = workerLayer(outbox, (effect) =>
        effect.id === hung.id
          ? Deferred.succeed(hungStarted, undefined).pipe(Effect.andThen(Deferred.await(release)))
          : Deferred.succeed(effect.id === other.id ? ran.other : ran.same, undefined).pipe(
              Effect.asVoid,
            ),
      );
      const within = <A>(effect: Effect.Effect<A>) =>
        Effect.gen(function* () {
          const fiber = yield* effect.pipe(Effect.timeoutOption("1 hour"), Effect.forkChild);
          yield* TestClock.adjust("1 hour");
          return yield* Fiber.join(fiber);
        });
      yield* outbox.enqueue([hung]);
      yield* Effect.gen(function* () {
        yield* EffectWorker.runDaemonWithOptions({ concurrency: 1 }).pipe(Effect.forkScoped);
        yield* Deferred.await(hungStarted);
        yield* outbox.enqueue([sameThread, other]);
        yield* outbox.notifyAvailable();
        assert.isTrue(Option.isSome(yield* within(Deferred.await(ran.other))));
        assert.isFalse(yield* Deferred.isDone(ran.same), "the hung effect's thread ran past it");
        assert.equal(Option.getOrThrow(yield* outbox.get(sameThread.id)).status, "pending");

        yield* Deferred.succeed(release, undefined);
        yield* outbox.awaitSettled(hung.id);
        assert.equal(Option.getOrThrow(yield* outbox.get(hung.id)).status, "succeeded");
        assert.isTrue(Option.isSome(yield* within(Deferred.await(ran.same))));
      }).pipe(Effect.provide(layer), Effect.scoped);
    }).pipe(Effect.provide(Layer.fresh(layerEffectOutboxProvided))),
);
