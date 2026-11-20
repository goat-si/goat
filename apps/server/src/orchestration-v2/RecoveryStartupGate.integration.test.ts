import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, ProjectId, RunAttemptId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerRuntimeStartup from "../serverRuntimeStartup.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { layerSharedApplicationDataPlaneTest, modelSelection } from "./runtimeLayer.testkit.ts";

const layer = Layer.mergeAll(
  EffectOutbox.layer,
  ProjectionStore.layer,
  ThreadCommandExecutor.layer,
).pipe(Layer.provideMerge(layerSharedApplicationDataPlaneTest));

it.layer(layer)("deferred recovery start", (it) => {
  it.effect.each([
    "before",
    "after",
    "during",
    "changed",
    "replacement",
    "claimed",
    "restart",
    "resend_crash",
    "none",
  ] as const)("startup Stop %s the gate fences the recovered resend", (stop) =>
    Effect.scoped(
      Effect.gen(function* () {
        const projects = yield* ProjectService.ProjectService;
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const threads = yield* ThreadManagement.ThreadManagementService;
        const locks = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const sink = yield* EventSink.EventSinkV2;
        const entered = yield* Deferred.make<void>();
        const release = yield* Deferred.make<void>();
        const gatedSink =
          stop === "during"
            ? {
                ...sink,
                writeIfRunCurrent: (input: Parameters<typeof sink.writeIfRunCurrent>[0]) =>
                  Deferred.succeed(entered, undefined).pipe(
                    Effect.andThen(Deferred.await(release)),
                    Effect.andThen(sink.writeIfRunCurrent(input)),
                  ),
              }
            : sink;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const projectId = ProjectId.make(`deferred-project:${stop}`);
        const threadId = ThreadId.make(`deferred-thread:${stop}`);
        const original = CommandId.make(`deferred-original:${stop}`);
        yield* projects.create({
          commandId: CommandId.make(`deferred-project-create:${stop}`),
          projectId,
          title: "Test",
          workspaceRoot: `/tmp/deferred-${stop}`,
        });
        yield* orchestrator.dispatch({
          type: "thread.create",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make(`deferred-thread-create:${stop}`),
          threadId,
          projectId,
          title: "Test",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
        });
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: original,
          threadId,
          messageId: MessageId.make(`deferred-message:${stop}`),
          text: "Do unattended work",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "start_immediately" },
        });
        const initial = yield* orchestrator.getThreadProjection(threadId);
        const run = initial.runs[0]!;
        const claimed = Option.getOrThrow(
          yield* outbox.claimNext({
            workerId: `prior:${stop}`,
            leaseDurationMs: 30_000,
            effectTypes: ["provider-turn.start"],
          }),
        );
        assert.isTrue(
          yield* outbox.fail({
            effectId: claimed.id,
            workerId: `prior:${stop}`,
            error: "process lost",
          }),
        );
        const makeRecovery = ProviderRuntimeRecovery.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              ServerSettings.layerTest({ continueThreadsAfterServerUpdate: true }),
              Layer.succeed(ProjectionStore.ProjectionStoreV2, projections),
              Layer.succeed(EventSink.EventSinkV2, gatedSink),
              Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
              IdAllocator.layer,
              Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
                runRecoveryOnce: Effect.succeed(false),
              }),
            ),
          ),
        );
        let recovery = yield* makeRecovery;
        yield* recovery.reconcile("startup");
        if (stop === "none") yield* recovery.reconcile("startup");
        if (stop === "restart") {
          recovery = yield* makeRecovery;
          yield* recovery.reconcile("startup");
        }
        let resendId = `effect:recovery-resend:${run.id}:1`;
        assert.isTrue(Option.isNone(yield* outbox.get(resendId)));
        const gate = yield* ServerRuntimeStartup.makeCommandGate;
        const stopFiber =
          stop === "before"
            ? yield* gate
                .enqueueCommand(
                  threads.interruptThread({
                    projectId,
                    commandId: CommandId.make(`deferred-stop:${stop}`),
                    threadId,
                    runId: run.id,
                    reason: "Stop",
                  }),
                )
                .pipe(Effect.forkScoped({ startImmediately: true }))
            : undefined;
        const preDrain =
          stop === "before"
            ? yield* ServerRuntimeStartup.releaseDeferredRecovery({ gate, recovery, locks }).pipe(
                Effect.forkScoped({ startImmediately: true }),
              )
            : undefined;
        yield* gate.signalCommandReady;
        yield* gate.awaitQueuedCommandsDrained;
        if (stop === "changed")
          yield* orchestrator.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("deferred-unrelated-change"),
            threadId,
            title: "Changed while recovering",
          });
        if (stop === "replacement") {
          const now = yield* DateTime.now;
          yield* sink.write({
            events: [
              {
                id: EventId.make("deferred-replacement-event"),
                type: "run.updated",
                threadId,
                runId: run.id,
                providerInstanceId: run.providerInstanceId,
                occurredAt: now,
                payload: {
                  ...run,
                  activeAttemptId: RunAttemptId.make("deferred-replacement-attempt"),
                },
              },
            ],
          });
        }
        if (stop === "after")
          yield* gate.enqueueCommand(
            threads.interruptThread({
              projectId,
              commandId: CommandId.make(`deferred-stop:${stop}`),
              threadId,
              runId: run.id,
              reason: "Stop",
            }),
          );
        if (stopFiber !== undefined) yield* Fiber.join(stopFiber);
        if (stop === "during") {
          const draining = yield* ServerRuntimeStartup.releaseDeferredRecovery({
            gate,
            recovery,
            locks,
          }).pipe(Effect.forkScoped({ startImmediately: true }));
          yield* Deferred.await(entered);
          const stopping = yield* gate
            .enqueueCommand(
              threads.interruptThread({
                projectId,
                commandId: CommandId.make(`deferred-stop:${stop}`),
                threadId,
                runId: run.id,
                reason: "Stop",
              }),
            )
            .pipe(Effect.forkScoped({ startImmediately: true }));
          assert.isUndefined(stopping.pollUnsafe());
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(draining);
          yield* Fiber.join(stopping);
        } else if (preDrain !== undefined) {
          yield* Fiber.join(preDrain);
        } else {
          yield* ServerRuntimeStartup.releaseDeferredRecovery({ gate, recovery, locks });
        }
        if (stop === "resend_crash") {
          const claim = Option.getOrThrow(
            yield* outbox.claimNext({
              workerId: "crashed-resend",
              leaseDurationMs: 30_000,
              effectTypes: ["provider-turn.start"],
            }),
          );
          assert.equal(claim.id, resendId);
          assert.isTrue(
            yield* outbox.fail({
              effectId: claim.id,
              workerId: "crashed-resend",
              error: "process lost before provider write",
            }),
          );
          recovery = yield* makeRecovery;
          yield* recovery.reconcile("startup");
          const nextGate = yield* ServerRuntimeStartup.makeCommandGate;
          yield* nextGate.signalCommandReady;
          yield* nextGate.awaitQueuedCommandsDrained;
          yield* ServerRuntimeStartup.releaseDeferredRecovery({ gate: nextGate, recovery, locks });
          resendId = `effect:recovery-resend:${run.id}:2`;
        }
        if (stop === "claimed") {
          const claimedResend = Option.getOrThrow(
            yield* outbox.claimNext({
              workerId: "claimed-recovery",
              leaseDurationMs: 30_000,
              effectTypes: ["provider-turn.start"],
            }),
          );
          assert.equal(claimedResend.id, resendId);
          yield* gate.enqueueCommand(
            threads.interruptThread({
              projectId,
              commandId: CommandId.make("deferred-stop:claimed"),
              threadId,
              runId: run.id,
              reason: "Stop",
            }),
          );
        }
        const resent = yield* outbox.get(resendId);
        if (stop === "replacement") {
          assert.isTrue(Option.isNone(resent));
          const current = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(
            current.runs[0]?.activeAttemptId,
            RunAttemptId.make("deferred-replacement-attempt"),
          );
          assert.isFalse(
            current.turnItems.some((item) => item.id === `turn-item:recovery-parked:${run.id}`),
          );
        } else if (stop === "changed") {
          assert.isTrue(Option.isNone(resent));
          const parked = yield* orchestrator.getThreadProjection(threadId);
          assert.equal(parked.runs[0]?.status, "queued");
          assert.isTrue(parked.runs[0]?.queueHeld === true);
          assert.isTrue(
            parked.turnItems.some((item) => item.id === `turn-item:recovery-parked:${run.id}`),
          );
        } else if (stop !== "none" && stop !== "restart" && stop !== "resend_crash") {
          if (stop === "during" || stop === "claimed") {
            assert.isTrue(Option.isSome(resent));
            if (Option.isSome(resent)) assert.equal(resent.value.status, "cancelled");
            yield* recovery.reconcile("startup");
            yield* ServerRuntimeStartup.releaseDeferredRecovery({ gate, recovery, locks });
            assert.isTrue(Option.isNone(yield* outbox.get(`effect:recovery-resend:${run.id}:2`)));
          } else assert.isTrue(Option.isNone(resent));
          assert.equal(
            (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
            "interrupted",
          );
        } else {
          assert.isTrue(Option.isSome(resent));
          if (Option.isSome(resent)) assert.equal(resent.value.commandId, original);
          yield* ServerRuntimeStartup.releaseDeferredRecovery({ gate, recovery, locks });
          assert.isTrue(Option.isSome(yield* outbox.get(resendId)));
          const starts: string[] = [];
          const workerLayer = EffectWorker.layerWithOptions({
            workerId: "deferred-test-worker",
          }).pipe(
            Layer.provide(
              Layer.succeed(EffectWorker.OrchestrationEffectExecutorV2, {
                execute: (effect) =>
                  Effect.sync(() => {
                    starts.push(effect.id);
                  }),
              }),
            ),
            Layer.provide(Layer.succeed(EffectOutbox.EffectOutboxV2, outbox)),
          );
          yield* Effect.gen(function* () {
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            assert.isTrue(yield* worker.runStartOnce);
            assert.isFalse(yield* worker.runStartOnce);
          }).pipe(Effect.provide(workerLayer));
          assert.deepEqual(starts, [resendId]);
          yield* threads.interruptThread({
            projectId,
            commandId: CommandId.make(`deferred-cleanup:${stop}`),
            threadId,
            runId: run.id,
            reason: "Stop",
          });
        }
      }).pipe(Effect.provide(IdAllocator.layer)),
    ),
  );
});
