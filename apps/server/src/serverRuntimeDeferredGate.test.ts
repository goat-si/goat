import { CommandId, ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "./persistence/Sqlite.ts";
import * as EffectOutbox from "./orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "./orchestration-v2/EffectWorker.ts";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as ServerRuntimeStartup from "./serverRuntimeStartup.ts";

it.effect("the recovery gate waits for pre-ready commands but not later commands", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* ServerRuntimeStartup.makeCommandGate;
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const queued = yield* gate
        .enqueueCommand(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* gate.signalCommandReady;
      yield* Deferred.await(entered);
      const drained = yield* gate.awaitQueuedCommandsDrained.pipe(
        Effect.forkScoped({ startImmediately: true }),
      );
      assert.isUndefined(drained.pollUnsafe());
      const late = yield* gate
        .enqueueCommand(Effect.never)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(queued);
      yield* Fiber.join(drained);
      assert.isUndefined(late.pollUnsafe());
      yield* Fiber.interrupt(late);
    }),
  ),
);

it.effect("ordinary startup effects can run while commands still wait at the gate", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const gate = yield* ServerRuntimeStartup.makeCommandGate;
      const outboxLayer = EffectOutbox.layer.pipe(Layer.provide(SqlitePersistence.layerMemory));
      const seen: string[] = [];
      const executorLayer = Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
        execute: (effect) =>
          Effect.sync(() => {
            seen.push(effect.id);
          }),
      });
      const services = yield* Layer.build(
        EffectWorker.layerWithOptions({ workerId: "startup-gate-test" }).pipe(
          Layer.provide(executorLayer),
          Layer.provideMerge(outboxLayer),
        ),
      );
      const outbox = Context.get(services, EffectOutbox.EffectOutboxV2);
      const worker = Context.get(services, EffectWorker.OrchestrationEffectWorkerV2);
      const pending = yield* gate
        .enqueueCommand(Effect.never)
        .pipe(Effect.forkScoped({ startImmediately: true }));
      yield* outbox.enqueue([
        {
          id: "effect:startup-cleanup",
          commandId: CommandId.make("command:startup-cleanup"),
          threadId: ThreadId.make("thread:startup-cleanup"),
          request: { type: "terminal.cleanup" },
        },
      ]);
      assert.isTrue(yield* worker.runOnce);
      assert.deepEqual(seen, ["effect:startup-cleanup"]);
      assert.isUndefined(pending.pollUnsafe());
      yield* Fiber.interrupt(pending);
    }),
  ),
);
