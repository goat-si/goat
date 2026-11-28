import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as CheckpointCaptureService from "./CheckpointCaptureService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

const layerProjectionStoreTest = Layer.mergeAll(
  ThreadCommandExecutor.layer,
  ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)),
  SqlitePersistence.layerMemory,
);

const projectId = ProjectId.make("project:checkpoint-capture-delegated");
const rootNodeId = NodeId.make("node:checkpoint-capture-delegated-root");
const providerThreadId = ProviderThreadId.make("provider-thread:checkpoint-capture-delegated");
const providerInstanceId = ProviderInstanceId.make("codex");
const driver = ProviderDriverKind.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} as const;

it.layer(layerProjectionStoreTest)("CheckpointCaptureStop", (it) => {
  // Stop can be accepted while the provider's successful terminal is being written: the run is
  // then `waiting` with a stored request and no result, and capture is what settles it.
  it.effect("ends a waiting run as interrupted when Stop was accepted before capture", () =>
    Effect.gen(function* () {
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const ids = yield* IdAllocator.IdAllocatorV2;
      const now = yield* DateTime.now;
      const stopThreadId = ThreadId.make("thread:checkpoint-capture-stop-race");
      const stopRunId = RunId.make("run:checkpoint-capture-stop-race");
      const stopScopeId = CheckpointScopeId.make("scope:checkpoint-capture-stop-race");
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-stop-race:thread"),
        type: "thread.created",
        threadId: stopThreadId,
        occurredAt: now,
        payload: {
          createdBy: "user",
          creationSource: "web",
          id: stopThreadId,
          projectId,
          title: "Stop accepted before capture",
          providerInstanceId,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          activeProviderThreadId: null,
          lineage: {
            parentThreadId: null,
            relationshipToParent: null,
            rootThreadId: stopThreadId,
          },
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
          archivedAt: null,
          settledOverride: null,
          settledAt: null,
          lastVisitedAt: null,
          deletedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-stop-race:run"),
        type: "run.updated",
        threadId: stopThreadId,
        runId: stopRunId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: stopRunId,
          threadId: stopThreadId,
          ordinal: 1,
          providerInstanceId,
          modelSelection,
          providerThreadId,
          userMessageId: MessageId.make("message:checkpoint-capture-stop-race"),
          rootNodeId,
          activeAttemptId: null,
          status: "waiting",
          requestedAt: now,
          startedAt: now,
          completedAt: null,
          checkpointId: null,
          contextHandoffId: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-stop-race:node"),
        type: "node.updated",
        threadId: stopThreadId,
        runId: stopRunId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: rootNodeId,
          threadId: stopThreadId,
          runId: stopRunId,
          parentNodeId: null,
          rootNodeId,
          kind: "root_turn",
          status: "waiting",
          countsForRun: true,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          runtimeRequestId: null,
          checkpointScopeId: stopScopeId,
          startedAt: now,
          completedAt: null,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-stop-race:provider-thread"),
        type: "provider-thread.updated",
        threadId: stopThreadId,
        nodeId: rootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: providerThreadId,
          driver,
          providerInstanceId,
          providerSessionId: null,
          appThreadId: stopThreadId,
          ownerNodeId: rootNodeId,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle",
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        },
      });
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-stop-race:scope"),
        type: "checkpoint-scope.created",
        threadId: stopThreadId,
        runId: stopRunId,
        nodeId: rootNodeId,
        occurredAt: now,
        payload: {
          id: stopScopeId,
          threadId: stopThreadId,
          runId: stopRunId,
          nodeId: rootNodeId,
          parentScopeId: null,
          providerThreadId,
          kind: "root_run",
          ordinalWithinParent: 0,
          advancesAppRunCount: true,
          cwd: "/repo",
          createdAt: now,
        },
      });
      const baseline = {
        id: CheckpointId.make("checkpoint:stop-race-baseline-0"),
        threadId: stopThreadId,
        scopeId: stopScopeId,
        runId: null,
        nodeId: rootNodeId,
        parentCheckpointId: null,
        ordinalWithinScope: 0,
        appRunOrdinal: null,
        ref: CheckpointRef.make("checkpoint-ref:stop-race-baseline-0"),
        status: "ready" as const,
        files: [],
        capturedAt: now,
      };
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-stop-race:baseline"),
        type: "checkpoint.captured",
        threadId: stopThreadId,
        nodeId: rootNodeId,
        driver,
        providerInstanceId,
        occurredAt: now,
        payload: baseline,
      });
      yield* projectionStore.apply({
        id: EventId.make("event:checkpoint-capture-stop-race:interrupt-request"),
        type: "turn-item.updated",
        threadId: stopThreadId,
        runId: stopRunId,
        nodeId: rootNodeId,
        providerInstanceId,
        occurredAt: now,
        payload: {
          id: ids.derive.runSignalTurnItem({ runId: stopRunId, signal: "interrupt-request" }),
          threadId: stopThreadId,
          runId: stopRunId,
          nodeId: rootNodeId,
          providerThreadId,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: "Interrupt requested",
          startedAt: now,
          completedAt: now,
          updatedAt: now,
          type: "run_interrupt_request",
          message: "Stopped by user",
        },
      });

      const committed = yield* Ref.make<ReadonlyArray<OrchestrationV2DomainEvent>>([]);
      const layerCapture = CheckpointCaptureService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            IdAllocator.layer,
            Layer.mock(CheckpointService.CheckpointServiceV2)({
              materializeBaselineCheckpoint: () => Effect.die("the baseline is already ready"),
              capture: () =>
                Effect.succeed({
                  ...baseline,
                  id: CheckpointId.make("checkpoint:stop-race-captured-1"),
                  runId: stopRunId,
                  parentCheckpointId: baseline.id,
                  ordinalWithinScope: 1,
                  appRunOrdinal: 1,
                  ref: CheckpointRef.make("checkpoint-ref:stop-race-captured-1"),
                }),
            }),
            Layer.mock(EventSink.EventSinkV2)({
              commitCommand: (input) =>
                Ref.set(committed, input.events).pipe(Effect.as({ committed: true } as never)),
            }),
          ),
        ),
      );

      yield* CheckpointCaptureService.CheckpointCaptureServiceV2.pipe(
        Effect.flatMap((service) =>
          service.execute({ threadId: stopThreadId, runId: stopRunId, scopeId: stopScopeId }),
        ),
        Effect.provide(layerCapture),
      );

      const events = yield* Ref.get(committed);
      const runUpdated = events.find((event) => event.type === "run.updated");
      assert.equal(
        runUpdated?.type === "run.updated" ? runUpdated.payload.status : undefined,
        "interrupted",
      );
      assert.isTrue(
        events.some(
          (event) =>
            event.type === "turn-item.updated" && event.payload.type === "run_interrupt_result",
        ),
        "the accepted Stop request must be paired with a result",
      );
    }).pipe(Effect.provide(IdAllocator.layer)),
  );
});
