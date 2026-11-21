import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, ProjectId, ThreadId } from "@goat/contracts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { makeFailedStartSettlement } from "./goat/FailedStartSettlement.ts";
import { layerSharedApplicationDataPlaneTest, modelSelection } from "./runtimeLayer.testkit.ts";

it.layer(
  Layer.mergeAll(EffectOutbox.layer, ProjectionStore.layer).pipe(
    Layer.provideMerge(layerSharedApplicationDataPlaneTest),
  ),
)("failed start settlement", (it) => {
  it.effect("Stop unblocks a starting run after a failed final settlement", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const projectId = ProjectId.make("failed-start-stop-project");
      const threadId = ThreadId.make("failed-start-stop-thread");
      yield* projects.create({
        commandId: CommandId.make("failed-start-project"),
        projectId,
        title: "Test",
        workspaceRoot: "/tmp/failed-start-stop",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("failed-start-create"),
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
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("failed-start-message"),
        threadId,
        messageId: MessageId.make("failed-start-message"),
        text: "First message",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      const run = before.runs[0]!;
      const claimed = Option.getOrThrow(
        yield* outbox.claimNext({ workerId: "fault-worker", leaseDurationMs: 30_000 }),
      );
      const failSettlement = makeFailedStartSettlement({
        projectionStore,
        idAllocator: ids,
        eventSink: {
          ...eventSink,
          writeIfRunCurrent: () =>
            Effect.fail(
              new EventSink.EventSinkWriteError({ eventCount: 1, cause: "injected failure" }),
            ),
        },
      });
      assert.isTrue(
        (yield* Effect.result(
          failSettlement({
            threadId,
            runId: run.id,
            attemptId: run.activeAttemptId!,
            rootNodeId: run.rootNodeId!,
          }),
        ))._tag === "Failure",
      );
      assert.isTrue(
        yield* outbox.fail({
          effectId: claimed.id,
          workerId: "fault-worker",
          error: "injected failure",
        }),
      );
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status, "starting");
      yield* threads.interruptThread({
        projectId,
        commandId: CommandId.make("failed-start-stop"),
        threadId,
        runId: run.id,
        reason: "Stop",
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status,
        "interrupted",
      );
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("failed-start-next"),
        threadId,
        messageId: MessageId.make("failed-start-next"),
        text: "Try again",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(after.runs.at(-1)?.status, "starting");
      assert.equal(after.messages.at(-1)?.text, "Try again");
      yield* threads.interruptThread({
        projectId,
        commandId: CommandId.make("failed-start-cleanup"),
        threadId,
        runId: after.runs.at(-1)!.id,
        reason: "Stop",
      });
    }).pipe(Effect.provide(IdAllocator.layer)),
  );
  it.effect("recovery holds the failed start for a person to edit", () =>
    Effect.gen(function* () {
      const projects = yield* ProjectService.ProjectService;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const projectId = ProjectId.make("recovery-edit-stop-project");
      const threadId = ThreadId.make("recovery-edit-stop-thread");
      yield* projects.create({
        commandId: CommandId.make("recovery-edit-project"),
        projectId,
        title: "Test",
        workspaceRoot: "/tmp/recovery-edit-stop",
      });
      yield* orchestrator.dispatch({
        type: "thread.create",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("recovery-edit-create"),
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
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("recovery-edit-update"),
        threadId,
        messageId: MessageId.make("recovery-edit-message"),
        text: "First message",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "start_immediately" },
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      const run = before.runs[0]!;
      const claimed = Option.getOrThrow(
        yield* outbox.claimNext({ workerId: "recovery-worker", leaseDurationMs: 30_000 }),
      );
      const failSettlement = makeFailedStartSettlement({
        projectionStore,
        idAllocator: ids,
        eventSink: {
          ...eventSink,
          writeIfRunCurrent: () =>
            Effect.fail(
              new EventSink.EventSinkWriteError({ eventCount: 1, cause: "injected failure" }),
            ),
        },
      });
      assert.isTrue(
        (yield* Effect.result(
          failSettlement({
            threadId,
            runId: run.id,
            attemptId: run.activeAttemptId!,
            rootNodeId: run.rootNodeId!,
          }),
        ))._tag === "Failure",
      );
      assert.isTrue(
        yield* outbox.fail({
          effectId: claimed.id,
          workerId: "recovery-worker",
          error: "injected failure",
        }),
      );
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs[0]?.status, "starting");
      const recoveryLayer = ProviderRuntimeRecovery.layer.pipe(
        Layer.provide(ServerSettings.layerTest()),
        Layer.provide(
          Layer.mergeAll(
            Layer.succeed(ProjectionStore.ProjectionStoreV2, projectionStore),
            Layer.succeed(EventSink.EventSinkV2, eventSink),
            Layer.succeed(EffectOutbox.EffectOutboxV2, outbox),
            IdAllocator.layer,
            Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
              runRecoveryOnce: Effect.succeed(false),
            }),
          ),
        ),
      );
      assert.include(yield* projectionStore.getRecoveryThreadIds("runtime-cleanup"), threadId);
      yield* Effect.gen(function* () {
        yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");
      }).pipe(Effect.provide(recoveryLayer));
      const recovered = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(recovered.runs[0]?.status, "queued");
      assert.isTrue(recovered.runs[0]?.queueHeld === true);
      assert.equal(recovered.messages[0]?.text, "First message");
      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make("recovery-edit-message"),
        threadId,
        runId: run.id,
        text: "Edited message",
      });
      const edited = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(edited.messages[0]?.text, "Edited message");
    }).pipe(Effect.provide(IdAllocator.layer)),
  );
});
