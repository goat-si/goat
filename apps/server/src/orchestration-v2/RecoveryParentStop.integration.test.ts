import { assert, it } from "@effect/vitest";
import { CommandId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerSettings from "../serverSettings.ts";
import * as EventSink from "./EventSink.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { createWatchingThread, delegate, layerTest, send } from "./ThreadStop.testkit.ts";
import { makeDeferredRecoveryResends } from "./goat/DeferredRecoveryResends.ts";
import { OrchestrationEffectExecutionError } from "./goat/EffectExecution.ts";

it.effect.each(["before", "during", "active"] as const)(
  "parent Stop %s the child resend recheck",
  (timing) =>
    Effect.scoped(
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const sink = yield* EventSink.EventSinkV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const ids = yield* IdAllocator.IdAllocatorV2;
        const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const parentId = ThreadId.make(`parent-recovery:${timing}`);
        yield* createWatchingThread(parentId, 4);
        yield* send(parentId, "parent", "start_immediately");
        const childId = yield* delegate(parentId, `child-${timing}`, "settled_only");
        const child = yield* orchestrator.getThreadProjection(childId);
        const run = child.runs[0]!;
        const attempt = child.attempts.find((item) => item.id === run.activeAttemptId)!;
        assert.equal(attempt.inputDelivery, "unsent");
        const original = Option.getOrThrow(yield* outbox.findOriginalStart(childId, run.id));
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const gatedSink =
          timing === "during"
            ? {
                ...sink,
                writeIfRunCurrent: (input: Parameters<typeof sink.writeIfRunCurrent>[0]) =>
                  Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(sink.writeIfRunCurrent(input)),
                  ),
              }
            : sink;
        const deferred = makeDeferredRecoveryResends({ projections, sink: gatedSink, ids, outbox });
        assert.isTrue(
          deferred.reserve({
            threadId: childId,
            run,
            attemptId: attempt.id,
            commandId: original.commandId,
            resendCount: 0,
          }),
        );
        yield* deferred.captureSequence(childId);
        const stopId = CommandId.make(`parent-stop:${timing}`);
        const stop = orchestrator.dispatch({
          type: "thread.stop",
          commandId: stopId,
          threadId: parentId,
        });
        if (timing === "before") {
          yield* stop;
          yield* outbox.reconcileAfterProcessLoss;
        }
        const draining = yield* deferred
          .drain(locks)
          .pipe(Effect.forkScoped({ startImmediately: true }));
        if (timing === "during") {
          yield* Deferred.await(entered);
          yield* stop;
          yield* Deferred.succeed(release, undefined);
        }
        yield* Fiber.join(draining);
        const resendId = `effect:recovery-resend:${run.id}:1`;
        const resent = yield* outbox.get(resendId);
        if (timing === "before") assert.isTrue(Option.isNone(resent));
        else assert.isTrue(Option.isSome(resent));
        if (timing !== "active") {
          const stopEffect = yield* outbox.get(`effect:${stopId}:delegated-tasks.stop`);
          assert.isTrue(Option.isSome(stopEffect));
          let stops = 0;
          let starts = 0;
          const workerLayer = EffectWorker.layerWithOptions({
            workerId: `parent-stop-worker:${timing}`,
          }).pipe(
            Layer.provide(
              Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
                execute: (effect) =>
                  effect.request.type === "delegated-tasks.stop"
                    ? threads
                        .stopDelegatedTasks({
                          threadId: effect.threadId,
                          commandId: effect.commandId,
                          childThreadIds: effect.request.childThreadIds,
                          reason: effect.request.reason,
                        })
                        .pipe(
                          Effect.mapError(
                            (cause) =>
                              new OrchestrationEffectExecutionError({
                                effectId: effect.id,
                                effectType: effect.request.type,
                                cause,
                              }),
                          ),
                          Effect.tap(() =>
                            Effect.sync(() => {
                              stops++;
                            }),
                          ),
                        )
                    : Effect.sync(() => {
                        if (
                          effect.request.type === "provider-turn.start" &&
                          effect.threadId === childId
                        )
                          starts++;
                      }),
              }),
            ),
            Layer.provide(Layer.succeed(EffectOutbox.EffectOutboxV2, outbox)),
          );
          yield* Effect.gen(function* () {
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            yield* worker.drain(32);
          }).pipe(Effect.provide(workerLayer));
          assert.equal(stops, 1);
          assert.isAtMost(starts, 1);
          assert.equal(
            (yield* orchestrator.getThreadProjection(childId)).runs[0]?.status,
            "interrupted",
          );
          const after = yield* outbox.get(resendId);
          if (Option.isSome(after)) assert.equal(after.value.status, "cancelled");
          const recovery = yield* ProviderRuntimeRecovery.make.pipe(
            Effect.provide(
              Layer.mergeAll(
                ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
                Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
                Layer.succeed(EventSink.EventSinkV2, sink),
                Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
                Layer.succeed(IdAllocator.IdAllocatorV2, ids),
                Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
                  runRecoveryOnce: Effect.succeed(false),
                }),
              ),
            ),
          );
          yield* recovery.reconcile("startup");
          yield* recovery.drainDeferredResends(locks);
          assert.isTrue(Option.isNone(yield* outbox.get(`effect:recovery-resend:${run.id}:2`)));
        }
      }).pipe(
        Effect.provide(Layer.mergeAll(layerTest, IdAllocator.layer, ThreadCommandExecutor.layer)),
      ),
    ),
);
