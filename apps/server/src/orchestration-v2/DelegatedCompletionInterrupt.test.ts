import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  NodeId,
  ProjectId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as IdAllocator from "@goat/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import * as ProviderContinuationService from "./ProviderContinuationService.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import {
  layerTest,
  seedParentWithTerminalTask,
  modelSelection,
  parentProviderThreadId,
  runEvent,
} from "./DelegatedCompletionDelivery.testkit.ts";

const layerContinuationWorkerTest = ProviderContinuationService.layer.pipe(
  Layer.provide(Layer.merge(ProviderContinuationRequests.layer, IdAllocator.layer)),
  Layer.provideMerge(layerTest),
);

it.layer(layerContinuationWorkerTest)("interrupted completion wakes", (it) => {
  it.effect.each([
    { name: "an interrupt keeps", holdQueue: false, siblingFinishesFirst: false },
    { name: "Stop disposes", holdQueue: true, siblingFinishesFirst: false },
    { name: "an interrupt reserves", holdQueue: false, siblingFinishesFirst: true },
  ])("$name a completion wake's other siblings", ({ holdQueue, siblingFinishesFirst }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const key = holdQueue
        ? "sibling-stop"
        : siblingFinishesFirst
          ? "sibling-finished-interrupt"
          : "sibling-interrupt";
      const threadId = ThreadId.make(`${key}-parent`);
      const originRunId = RunId.make(`${key}-origin`);
      const incomingTaskId = NodeId.make(`${key}-incoming`);
      yield* seedParentWithTerminalTask({
        threadId,
        projectId: ProjectId.make(`${key}-project`),
        runId: originRunId,
        rootNodeId: NodeId.make(`${key}-origin-root`),
        taskId: incomingTaskId,
        deliveryState: "claimed",
        deliveryTaskIds: [incomingTaskId],
        completionWake: "always",
        now,
      });
      const originRootId = NodeId.make(`${key}-origin-root`);
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
      yield* sink.write({
        events: [
          {
            ...runEvent({ threadId, runId: originRunId, ordinal: 1, status: "completed", now }),
            payload: { ...origin, status: "completed", completedAt: now },
          },
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
      yield* orchestrator.resumeQueuedRuns;
      const wake = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.userMessageId === delivery.messageId,
      )!;
      const childRun = (yield* orchestrator.getThreadProjection(sibling.childThreadId!)).runs[0]!;
      const completeSibling = Effect.gen(function* () {
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
        return yield* sink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === sibling.id &&
              stored.event.payload.status === "completed",
          ),
          Stream.take(1),
          Stream.runDrain,
          Effect.as(afterSequence),
        );
      });
      if (siblingFinishesFirst) {
        yield* completeSibling;
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
            (task) => task.id === sibling.id,
          )?.completionDelivery?.state,
          "pending",
        );
      }
      const beforeInterrupt = yield* sink.latestSequence();
      const interrupted = yield* orchestrator.dispatch(
        holdQueue
          ? { type: "thread.stop", commandId: CommandId.make(`${key}-interrupt`), threadId }
          : {
              type: "run.interrupt",
              commandId: CommandId.make(`${key}-interrupt`),
              threadId,
              runId: wake.id,
            },
      );
      // The wake's terminal may claim the sibling right after commit, so read what the interrupt
      // itself wrote rather than a later projection.
      const interruptDelivery = new Map(
        interrupted.storedEvents.flatMap(({ event }) =>
          event.type === "subagent.updated"
            ? [[event.payload.id, event.payload.completionDelivery?.state] as const]
            : [],
        ),
      );
      const interruptCohort = interrupted.storedEvents.flatMap(({ event }) =>
        event.type === "run.updated" && event.payload.id === originRunId
          ? [event.payload.delegatedCompletion]
          : [],
      );
      assert.equal(interruptDelivery.get(incomingTaskId), "disposed");
      assert.equal(interruptCohort.at(-1)?.disposition, holdQueue ? "stopped" : "open");
      if (holdQueue) {
        assert.equal(interruptDelivery.get(sibling.id), "disposed");
        return;
      }
      assert.isFalse(interruptDelivery.has(sibling.id));

      const afterSequence = siblingFinishesFirst ? beforeInterrupt : yield* completeSibling;
      // The wake's terminal, or the sibling's own completion, reserves the successor.
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
      const woken = yield* orchestrator.getThreadProjection(threadId);
      const successor = woken.runs.find((run) => run.id === originRunId)?.delegatedCompletion
        ?.delivery;
      assert.equal(successor?.generation, delivery.generation + 1);
      assert.deepEqual(successor?.taskIds, [sibling.id]);
      assert.notEqual(successor?.messageId, delivery.messageId);

      // ProviderContinuationService consumes the claim's offer and dispatches the successor.
      yield* sink.stream({ afterSequence, eventType: "message.updated" }).pipe(
        Stream.filter(
          (stored) =>
            stored.event.type === "message.updated" &&
            stored.event.payload.id === successor!.messageId,
        ),
        Stream.take(1),
        Stream.runDrain,
      );
      // Repeated recovery re-offers every open delivery; none may wake the parent twice.
      yield* orchestrator.resumeQueuedRuns;
      yield* orchestrator.recoverDelegatedTasks;
      yield* orchestrator.recoverDelegatedTasks;
      yield* orchestrator.resumeQueuedRuns;
      const delivered = yield* orchestrator.getThreadProjection(threadId);
      const cohort = delivered.runs.find((run) => run.id === originRunId)?.delegatedCompletion;
      assert.equal(cohort?.disposition, "open");
      assert.equal(cohort?.nextGeneration, delivery.generation + 2);
      assert.deepEqual(cohort?.delivery, successor);
      assert.deepEqual(
        delivered.messages
          .filter((message) => message.delegatedCompletion?.parentRunId === originRunId)
          .map((message) => [message.id, message.delegatedCompletion]),
        [
          [
            delivery.messageId,
            {
              parentRunId: originRunId,
              generation: delivery.generation,
              taskIds: [incomingTaskId],
            },
          ],
          [
            successor!.messageId,
            { parentRunId: originRunId, generation: successor!.generation, taskIds: [sibling.id] },
          ],
        ],
      );
      const successorRuns = delivered.runs.filter(
        (run) => run.userMessageId === successor!.messageId,
      );
      assert.equal(successorRuns.length, 1);
      assert.equal(successorRuns[0]?.status, "starting");
      assert.equal(
        delivered.subagents.find((task) => task.id === sibling.id)?.completionDelivery?.state,
        "claimed",
      );
    }),
  );
});

// Stop ends a run whose provider turn has not started in the same command, with the same time,
// as it cancels the queued completion wake; the run that ran presents either way (d76e06679b).
it.layer(layerTest)("Stop before the provider turn starts", (it) => {
  it.effect.each([
    { name: "with a completion wake cancelled at the same time", wake: true },
    { name: "with no queued wake", wake: false },
  ])("the stopped thread presents its interrupted run $name", ({ wake }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const key = wake ? "stop-tie-wake" : "stop-tie-alone";
      const threadId = ThreadId.make(`thread:${key}`);
      const runId = RunId.make(`${key}-origin`);
      const rootNodeId = NodeId.make(`${key}-origin-root`);
      const taskId = NodeId.make(`${key}-task`);
      const attemptId = RunAttemptId.make(`${key}-attempt`);
      yield* seedParentWithTerminalTask({
        threadId,
        projectId: ProjectId.make(`${key}-project`),
        runId,
        rootNodeId,
        taskId,
        deliveryState: wake ? "claimed" : "acknowledged",
        ...(wake ? { deliveryTaskIds: [taskId] } : {}),
        completionWake: "always",
        now,
      });
      const origin = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.id === runId,
      )!;
      // A running attempt with no provider turn: Stop ends the run itself.
      yield* sink.write({
        events: [
          {
            id: EventId.make(`event:${key}-root`),
            type: "node.updated",
            threadId,
            runId,
            nodeId: rootNodeId,
            occurredAt: now,
            payload: {
              id: rootNodeId,
              threadId,
              runId,
              parentNodeId: null,
              rootNodeId,
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
          {
            id: EventId.make(`event:${key}-attempt`),
            type: "run-attempt.updated",
            threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: attemptId,
              runId,
              attemptOrdinal: 1,
              rootNodeId,
              providerInstanceId: modelSelection.instanceId,
              providerThreadId: parentProviderThreadId(threadId),
              providerTurnId: null,
              reason: "initial",
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          },
          {
            id: EventId.make(`event:${key}-attempt-run`),
            type: "run.updated",
            threadId,
            runId,
            nodeId: rootNodeId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: { ...origin, activeAttemptId: attemptId },
          },
        ],
      });
      const delivery = origin.delegatedCompletion?.delivery ?? null;
      if (delivery !== null) {
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
            parentRunId: runId,
            generation: delivery.generation,
            taskIds: delivery.taskIds,
          },
        });
      }
      const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.filter(
        (run) => run.status === "queued",
      );
      assert.equal(queued.length, wake ? 1 : 0);
      const stopped = yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make(`${key}-stop`),
        threadId,
      });
      const written = new Map(
        stopped.storedEvents.flatMap(({ event }) =>
          event.type === "run.updated" ? [[event.payload.id, event.payload] as const] : [],
        ),
      );
      const ended = written.get(runId)!;
      assert.equal(ended.status, "interrupted");
      if (wake) {
        const cancelled = written.get(queued[0]!.id)!;
        assert.equal(cancelled.status, "cancelled");
        assert.isNull(cancelled.startedAt);
        assert.deepEqual(cancelled.completedAt, ended.completedAt);
      }
      const sqlShell = (yield* orchestrator.getThreadShell(threadId))!;
      const memoryShell = ProjectionStore.threadShellFromProjection(
        yield* orchestrator.getThreadProjection(threadId),
      );
      for (const shell of [sqlShell, memoryShell]) {
        assert.equal(shell.status, "interrupted");
        assert.equal(shell.latestRunId, runId);
      }
    }),
  );
});
