import { assert, it } from "@effect/vitest";
import { CommandId, EventId, NodeId, ProjectId, RunId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import * as ProviderContinuationService from "./ProviderContinuationService.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  layerTest,
  seedParentWithTerminalTask,
  modelSelection,
  runEvent,
} from "./DelegatedCompletionDelivery.testkit.ts";

const layerContinuationWorkerTest = ProviderContinuationService.layer.pipe(
  Layer.provide(Layer.merge(ProviderContinuationRequests.layer, IdAllocator.layer)),
  Layer.provideMerge(layerTest),
);

const queueCompletionWakeBesideRunningSibling = (key: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make(`${key}-parent`);
    const originRunId = RunId.make(`${key}-origin`);
    const originRootId = NodeId.make(`${key}-origin-root`);
    const incomingTaskId = NodeId.make(`${key}-incoming`);
    yield* seedParentWithTerminalTask({
      threadId,
      projectId: ProjectId.make(`${key}-project`),
      runId: originRunId,
      rootNodeId: originRootId,
      taskId: incomingTaskId,
      deliveryState: "claimed",
      deliveryTaskIds: [incomingTaskId],
      completionWake: "always",
      now,
    });
    yield* sink.write({
      events: [
        {
          id: EventId.make(`event:${key}-origin-root`),
          type: "node.updated",
          threadId,
          runId: originRunId,
          nodeId: originRootId,
          occurredAt: now,
          payload: {
            id: originRootId,
            threadId,
            runId: originRunId,
            parentNodeId: null,
            rootNodeId: originRootId,
            kind: "root_turn",
            status: "running",
            countsForRun: true,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
      ],
    });
    yield* orchestrator.dispatch({
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "mcp",
      commandId: CommandId.make(`${key}-sibling`),
      parentThreadId: threadId,
      parentRunId: originRunId,
      parentNodeId: originRootId,
      task: "Keep working",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      completionWake: "always",
    });
    const seeded = yield* orchestrator.getThreadProjection(threadId);
    const origin = seeded.runs.find((run) => run.id === originRunId)!;
    const sibling = seeded.subagents.find((task) => task.id !== incomingTaskId)!;
    // The coordinator finished its spawning turn but is busy with another run, so the wake queues.
    yield* sink.write({
      events: [
        {
          ...runEvent({ threadId, runId: originRunId, ordinal: 1, status: "completed", now }),
          payload: { ...origin, status: "completed", completedAt: now },
        },
        runEvent({
          threadId,
          runId: RunId.make(`${key}-busy`),
          ordinal: 2,
          status: "running",
          now,
        }),
      ],
    });
    const delivery = origin.delegatedCompletion!.delivery!;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "agent",
      creationSource: "server",
      commandId: CommandId.make(`${key}-wake`),
      threadId,
      messageId: delivery.messageId,
      text: "Delegated task completed",
      attachments: [],
      modelSelection,
      dispatchMode: { type: "queue_after_active" },
      delegatedCompletion: {
        parentRunId: originRunId,
        generation: delivery.generation,
        taskIds: delivery.taskIds,
      },
    });
    const wake = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
      (run) => run.userMessageId === delivery.messageId,
    )!;
    assert.equal(wake.status, "queued");
    const completeSibling = Effect.gen(function* () {
      const childRun = (yield* orchestrator.getThreadProjection(sibling.childThreadId!)).runs[0]!;
      const afterSequence = yield* sink.latestSequence();
      yield* sink.write({
        events: [
          {
            ...runEvent({
              threadId: sibling.childThreadId!,
              runId: childRun.id,
              ordinal: childRun.ordinal,
              status: "completed",
              now,
            }),
            payload: { ...childRun, status: "completed", completedAt: now },
          },
        ],
      });
      return afterSequence;
    });
    return {
      orchestrator,
      sink,
      now,
      threadId,
      originRunId,
      incomingTaskId,
      sibling,
      delivery,
      wake,
      completeSibling,
    };
  });

it.layer(layerContinuationWorkerTest)("queued completion wakes", (it) => {
  it.effect("cancelling a queued completion wake keeps its other siblings", () =>
    Effect.gen(function* () {
      const {
        orchestrator,
        sink,
        threadId,
        originRunId,
        incomingTaskId,
        sibling,
        delivery,
        wake,
        completeSibling,
      } = yield* queueCompletionWakeBesideRunningSibling("sibling-queued-cancel");
      const cancelled = yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make("sibling-queued-cancel-cancel"),
        threadId,
        runId: wake.id,
      });
      const cancelDelivery = new Map(
        cancelled.storedEvents.flatMap(({ event }) =>
          event.type === "subagent.updated"
            ? [[event.payload.id, event.payload.completionDelivery?.state] as const]
            : [],
        ),
      );
      assert.equal(cancelDelivery.get(incomingTaskId), "disposed");
      assert.notEqual(
        cancelDelivery.get(sibling.id),
        "disposed",
        "cancelling the wake must not dispose a still-running sibling it did not carry",
      );
      const afterCancel = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        afterCancel.runs.find((run) => run.id === originRunId)?.delegatedCompletion?.disposition,
        "open",
      );

      const afterSequence = yield* completeSibling;
      yield* sink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.id === sibling.id &&
            stored.event.payload.completionDelivery?.state === "claimed",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const successor = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.id === originRunId,
      )?.delegatedCompletion?.delivery;
      assert.deepEqual(successor?.taskIds, [sibling.id]);
      assert.notEqual(successor?.messageId, delivery.messageId);
    }),
  );

  it.effect("settling with a queued completion wake disposes its running siblings", () =>
    Effect.gen(function* () {
      const { orchestrator, sink, now, threadId, originRunId, sibling, wake, completeSibling } =
        yield* queueCompletionWakeBesideRunningSibling("sibling-settle");
      const busy = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.status === "running",
      )!;
      yield* sink.write({
        events: [
          {
            ...runEvent({
              threadId,
              runId: busy.id,
              ordinal: busy.ordinal,
              status: "cancelled",
              now,
            }),
            payload: { ...busy, status: "cancelled", completedAt: now },
          },
          {
            ...runEvent({ threadId, runId: wake.id, ordinal: wake.ordinal, status: "queued", now }),
            payload: { ...wake, queueHeld: true },
          },
        ],
      });

      const settled = yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("sibling-settle-settle"),
        threadId,
      });
      assert.deepEqual(
        settled.storedEvents.flatMap(({ event }) =>
          event.type === "run.updated" && event.payload.id === wake.id
            ? [event.payload.status]
            : [],
        ),
        ["cancelled"],
      );
      const afterSettle = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        afterSettle.subagents.find((task) => task.id === sibling.id)?.completionDelivery?.state,
        "disposed",
      );

      const afterSequence = yield* completeSibling;
      yield* sink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.id === sibling.id &&
            stored.event.payload.status === "completed",
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      const afterLateResult = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        afterLateResult.subagents.find((task) => task.id === sibling.id)?.completionDelivery?.state,
        "disposed",
      );
      assert.deepEqual(
        afterLateResult.runs.map((run) => run.id),
        afterSettle.runs.map((run) => run.id),
      );
      assert.equal(
        afterLateResult.runs.find((run) => run.id === originRunId)?.delegatedCompletion
          ?.disposition,
        "disposed",
      );
      assert.equal(afterLateResult.thread.settledOverride, "settled");
    }),
  );
});
