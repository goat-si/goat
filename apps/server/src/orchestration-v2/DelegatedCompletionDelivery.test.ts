import {
  reconcileCommandId,
  runEvent,
  seedRestartCancelledChild,
} from "./DelegatedCompletionDelivery.testkit.ts";
import { derive } from "@goat/provider-core/server/IdAllocator";
import { assert, it, vi } from "@effect/vitest";
import {
  CheckpointId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import {
  modelSelection,
  driver,
  layerTest,
  seedParentWithTerminalTask,
} from "./DelegatedCompletionDelivery.testkit.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";

it.layer(layerTest)("delegated completion delivery repairs", (it) => {
  it.effect.each(["always", "settled_only"] as const)(
    "remote %s shares the completion mailbox and acknowledgement",
    (completionWake) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make(`remote-mailbox-${completionWake}`);
        const runId = RunId.make(`remote-mailbox-run-${completionWake}`);
        const taskId = NodeId.make(`remote-mailbox-task-${completionWake}`);
        yield* seedParentWithTerminalTask({
          threadId,
          runId,
          taskId,
          projectId: ProjectId.make(`remote-mailbox-project-${completionWake}`),
          rootNodeId: NodeId.make("root"),
          deliveryState: "delivered",
          completionWake,
          remote: true,
          now,
        });
        const before = yield* orchestrator.getThreadProjection(threadId);
        assert.isNull(before.subagents[0]?.childThreadId);
        assert.equal(before.subagents[0]?.remote?.host, "box");
        yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make(`remote-ack-${completionWake}`),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });
        yield* orchestrator.recoverDelegatedTasks;
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.subagents[0]?.completionDelivery?.state, "acknowledged");
        assert.equal(after.messages.length, before.messages.length);
      }),
  );

  it.effect("recovers missing registration and keeps the first remote terminal", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("remote-parent");
      const runId = RunId.make("remote-parent-run");
      const root = NodeId.make("remote-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        runId,
        rootNodeId: root,
        projectId: ProjectId.make("remote-project"),
        taskId: NodeId.make("seed-task"),
        deliveryState: "acknowledged",
        now,
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      const missing = {
        type: "delegated_task.remote.result" as const,
        commandId: CommandId.make("missing-result"),
        parentThreadId: threadId,
        taskId: NodeId.make("never-registered"),
        correlationId: "rr-missing",
        status: "failed" as const,
        summary: "launch outcome unknown",
      };
      const noop = yield* orchestrator.dispatch(missing);
      assert.equal(noop.storedEvents.length, 0);
      yield* orchestrator.dispatch(missing);
      const missingProgress = yield* orchestrator.dispatch({
        type: "delegated_task.remote.progress",
        commandId: CommandId.make("missing-progress"),
        parentThreadId: threadId,
        taskId: NodeId.make("never-registered"),
        correlationId: "rr-missing",
        remoteThreadId: null,
        summary: "unknown",
      });
      assert.equal(missingProgress.storedEvents.length, 0);
      const commandId = CommandId.make("register-remote");
      const taskId = derive.delegatedTaskNode({ commandId });
      // Existing seed omits the root execution node; registration requires it.
      yield* sink.write({
        events: [
          {
            id: EventId.make("remote-root-event"),
            type: "node.updated",
            threadId,
            runId,
            nodeId: root,
            occurredAt: now,
            payload: {
              id: root,
              threadId,
              runId,
              parentNodeId: null,
              rootNodeId: root,
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
      const registered = yield* orchestrator.dispatch({
        type: "delegated_task.remote.register",
        commandId,
        parentThreadId: threadId,
        parentRunId: runId,
        parentNodeId: root,
        createdBy: "agent",
        creationSource: "mcp",
        task: "Inspect remote repository",
        modelSelection,
        driver,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "settled_only",
        remote: { host: "build-box", threadId: null, correlationId: "rr-A" },
      });
      assert.deepEqual(
        registered.storedEvents.map((stored) => stored.event.type),
        ["node.updated", "subagent.updated", "turn-item.updated"],
      );
      yield* orchestrator.dispatch({
        type: "delegated_task.remote.result",
        commandId: CommandId.make("result-A"),
        parentThreadId: threadId,
        taskId,
        correlationId: "rr-A",
        status: "completed",
        summary: "A done",
      });
      const late = yield* orchestrator.dispatch({
        type: "delegated_task.remote.result",
        commandId: CommandId.make("late-cancel-A"),
        parentThreadId: threadId,
        taskId,
        correlationId: "rr-A",
        status: "cancelled",
        summary: "late cancellation",
      });
      assert.equal(late.storedEvents.length, 0);
      const lateProgress = yield* orchestrator.dispatch({
        type: "delegated_task.remote.progress",
        commandId: CommandId.make("late-progress-A"),
        parentThreadId: threadId,
        taskId,
        correlationId: "rr-A",
        remoteThreadId: null,
        summary: "late progress",
      });
      assert.equal(lateProgress.storedEvents.length, 0);
      const after = yield* orchestrator.getThreadProjection(threadId);
      const task = after.subagents.find((value) => value.id === taskId)!;
      assert.isNull(task.childThreadId);
      assert.equal(task.status, "completed");
      assert.equal(task.result, "A done");
      assert.equal(after.contextTransfers.length, before.contextTransfers.length);
    }),
  );
  it.effect(
    "stopping a completion wake disposes both cohorts without reviving them on late results",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("stop-wake-parent");
        const originRunId = RunId.make("stop-wake-origin");
        const incomingTaskId = NodeId.make("stop-wake-incoming");
        yield* seedParentWithTerminalTask({
          threadId,
          projectId: ProjectId.make("stop-wake-project"),
          runId: originRunId,
          rootNodeId: NodeId.make("stop-wake-origin-root"),
          taskId: incomingTaskId,
          deliveryState: "claimed",
          deliveryTaskIds: [incomingTaskId],
          completionWake: "always",
          now,
        });
        const origin = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
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
          commandId: CommandId.make("stop-wake-start"),
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
        yield* orchestrator.dispatch({
          type: "delegated_task.request",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: CommandId.make("stop-wake-delegate"),
          parentThreadId: threadId,
          parentRunId: wake.id,
          parentNodeId: wake.rootNodeId!,
          task: "Do the next round",
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
        });
        const delegated = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
          (task) => task.runId === wake.id,
        )!;
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-wake-interrupt"),
          threadId,
        });
        const stopped = yield* orchestrator.getThreadProjection(threadId);
        for (const runId of [originRunId, wake.id]) {
          const run = stopped.runs.find((row) => row.id === runId)!;
          assert.equal(run.delegatedCompletion?.disposition, "stopped");
          assert.isNull(run.delegatedCompletion?.delivery);
        }
        assert.equal(stopped.runs.find((run) => run.id === wake.id)?.status, "interrupted");
        for (const taskId of [incomingTaskId, delegated.id]) {
          assert.equal(
            stopped.subagents.find((task) => task.id === taskId)?.completionDelivery?.state,
            "disposed",
          );
        }
        assert.equal(
          stopped.subagents.find((task) => task.id === incomingTaskId)?.result,
          "child finished",
        );

        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "user",
          creationSource: "web",
          commandId: CommandId.make("stop-wake-newer-work"),
          threadId,
          messageId: MessageId.make("stop-wake-newer-work"),
          text: "Start unrelated work",
          attachments: [],
          modelSelection,
          dispatchMode: { type: "queue_after_active" },
        });
        yield* orchestrator.resumeQueuedRuns;
        const newer = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(newer.runs.at(-1)?.status, "starting");

        const childThreadId = delegated.childThreadId!;
        const childRun = (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]!;
        const afterSequence = yield* sink.latestSequence();
        yield* sink.write({
          events: [
            {
              ...runEvent({
                threadId: childThreadId,
                runId: childRun.id,
                ordinal: childRun.ordinal,
                status: "completed",
                now,
              }),
              payload: { ...childRun, status: "completed", completedAt: now },
            },
          ],
        });
        yield* sink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" &&
              stored.event.payload.id === delegated.id &&
              stored.event.payload.status === "completed",
          ),
          Stream.take(1),
          Stream.runDrain,
        );
        const finished = yield* orchestrator.getThreadProjection(threadId);
        const lateTask = finished.subagents.find((task) => task.id === delegated.id)!;
        assert.equal(lateTask.status, "completed");
        assert.isNotNull(lateTask.result);
        assert.equal(lateTask.completionDelivery?.state, "disposed");
        assert.deepEqual(finished.runs, newer.runs);
        assert.deepEqual(finished.messages, newer.messages);
      }),
  );

  it.effect("acceptance batches pending siblings without acknowledging their results", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("mailbox-batch");
      const runId = RunId.make("mailbox-parent");
      const taskId = NodeId.make("mailbox-first");
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      yield* seedParentWithTerminalTask({
        threadId,
        runId,
        projectId: ProjectId.make("mailbox-project"),
        rootNodeId: NodeId.make("mailbox-root"),
        taskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [taskId],
        now,
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const task = projection.subagents[0]!;
      const pendingIds = [NodeId.make("mailbox-second"), NodeId.make("mailbox-third")];
      yield* sink.write({
        events: [
          {
            id: EventId.make("mailbox-message"),
            type: "message.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: messageId,
              threadId,
              runId,
              nodeId: task.parentNodeId,
              role: "user",
              text: "Background task finished",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
              delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
            },
          },
          ...pendingIds.map((id) => ({
            id: EventId.make(`event:${id}`),
            type: "subagent.updated" as const,
            threadId,
            runId,
            nodeId: id,
            occurredAt: now,
            payload: {
              ...task,
              id,
              completionDelivery: { state: "pending" as const, observedByRunId: null },
            },
          })),
        ],
      });
      yield* orchestrator.dispatch({
        type: "notification.delivery.accept",
        commandId: CommandId.make("accept-first"),
        threadId,
        messageId,
      });
      const accepted = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        accepted.subagents.find((row) => row.id === taskId)?.completionDelivery?.state,
        "delivered",
      );
      const cohort = accepted.runs.find((row) => row.id === runId)?.delegatedCompletion;
      assert.deepEqual(cohort?.delivery?.taskIds, pendingIds);
      assert.equal(cohort?.delivery?.generation, 2);
      for (const id of pendingIds) {
        assert.deepEqual(accepted.subagents.find((row) => row.id === id)?.completionDelivery, {
          state: "claimed",
          observedByRunId: null,
        });
      }
      yield* orchestrator.dispatch({
        type: "notification.delivery.accept",
        commandId: CommandId.make("repeat-old-acceptance"),
        threadId,
        messageId,
      });
      const duplicate = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(duplicate.runs.find((row) => row.id === runId)?.delegatedCompletion, cohort);
    }),
  );

  it.effect("acceptance batches a settled_only sibling once its spawning run ended", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("mailbox-mixed");
      const runId = RunId.make("mailbox-mixed-parent");
      const taskId = NodeId.make("mailbox-mixed-always");
      const siblingId = NodeId.make("mailbox-mixed-settled-only");
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      yield* seedParentWithTerminalTask({
        remote: true,
        threadId,
        runId,
        projectId: ProjectId.make("mailbox-mixed-project"),
        rootNodeId: NodeId.make("mailbox-mixed-root"),
        taskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [taskId],
        now,
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const task = projection.subagents[0]!;
      const spawningRun = projection.runs.find((row) => row.id === runId)!;
      yield* sink.write({
        events: [
          {
            ...runEvent({ threadId, runId, ordinal: 1, status: "cancelled", now }),
            payload: { ...spawningRun, status: "cancelled" as const, completedAt: now },
          },
          runEvent({
            threadId,
            runId: RunId.make("mailbox-mixed-continuation"),
            ordinal: 2,
            status: "running",
            now,
          }),
          {
            id: EventId.make("mailbox-mixed-message"),
            type: "message.updated",
            threadId,
            runId,
            occurredAt: now,
            payload: {
              id: messageId,
              threadId,
              runId,
              nodeId: task.parentNodeId,
              role: "user",
              text: "Background task finished",
              attachments: [],
              streaming: false,
              createdBy: "agent",
              creationSource: "server",
              createdAt: now,
              updatedAt: now,
              delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
            },
          },
          {
            id: EventId.make(`event:${siblingId}`),
            type: "subagent.updated" as const,
            threadId,
            runId,
            nodeId: siblingId,
            occurredAt: now,
            payload: {
              ...task,
              id: siblingId,
              completionWake: "settled_only" as const,
              completionDelivery: { state: "pending" as const, observedByRunId: null },
            },
          },
        ],
      });
      yield* orchestrator.dispatch({
        type: "notification.delivery.accept",
        commandId: CommandId.make("accept-mixed"),
        threadId,
        messageId,
      });
      const accepted = yield* orchestrator.getThreadProjection(threadId);
      const cohort = accepted.runs.find((row) => row.id === runId)?.delegatedCompletion;
      assert.deepEqual(cohort?.delivery?.taskIds, [siblingId]);
      assert.equal(
        accepted.subagents.find((row) => row.id === siblingId)?.completionDelivery?.state,
        "claimed",
      );
    }),
  );

  it.effect("builds completion text and metadata from the same live cohort", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:delegated-delivery-live-cohort");
      const projectId = ProjectId.make("project:delegated-delivery-live-cohort");
      const runId = RunId.make("run:delegated-delivery-live-cohort");
      const rootNodeId = NodeId.make("node:delegated-delivery-live-cohort-root");
      const firstTaskId = NodeId.make("node:delegated-delivery-live-cohort-first");
      const secondTaskId = NodeId.make("node:delegated-delivery-live-cohort-second");
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);

      yield* seedParentWithTerminalTask({
        remote: true,
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: firstTaskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [firstTaskId, secondTaskId],
        now,
      });

      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:delegated-delivery-live-cohort"),
        threadId,
        messageId,
        text: `Delegated task ${firstTaskId} reached a terminal state.`,
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
        delegatedCompletion: {
          parentRunId: runId,
          generation: 1,
          taskIds: [firstTaskId],
        },
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      const message = projection.messages.find((candidate) => candidate.id === messageId);
      assert.deepEqual(message?.delegatedCompletion?.taskIds, [firstTaskId, secondTaskId]);
      assert.include(message?.text ?? "", String(firstTaskId));
      assert.include(message?.text ?? "", String(secondTaskId));
      assert.include(message?.text ?? "", "task.read");
      assert.include(message?.text ?? "", "child finished");
    }),
  );

  it.effect.each([
    {
      name: "oversized UTF-8 result",
      first: "界".repeat(6_000),
      second: "small result",
      inlineFirst: false,
      inlineSecond: true,
    },
    {
      name: "combined results",
      first: "a".repeat(10_000),
      second: "b".repeat(10_000),
      inlineFirst: true,
      inlineSecond: false,
    },
  ])("points to task.read for $name beyond the inline budget", (testCase) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make(`thread:inline-budget:${testCase.name}`);
      const runId = RunId.make(`run:inline-budget:${testCase.name}`);
      const firstTaskId = NodeId.make(`node:inline-first:${testCase.name}`);
      const secondTaskId = NodeId.make(`node:inline-second:${testCase.name}`);
      const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
      yield* seedParentWithTerminalTask({
        threadId,
        projectId: ProjectId.make(`project:inline-budget:${testCase.name}`),
        runId,
        rootNodeId: NodeId.make(`node:inline-budget:${testCase.name}`),
        taskId: firstTaskId,
        deliveryState: "claimed",
        completionWake: "always",
        deliveryTaskIds: [firstTaskId, secondTaskId],
        now,
      });
      const parent = yield* orchestrator.getThreadProjection(threadId);
      const task = parent.subagents[0]!;
      yield* sink.write({
        events: [
          { id: firstTaskId, result: testCase.first, status: "failed" as const },
          { id: secondTaskId, result: testCase.second, status: "cancelled" as const },
        ].map(({ id, result, status }) => ({
          id: EventId.make(`event:inline-budget:${id}`),
          type: "subagent.updated" as const,
          threadId,
          runId,
          nodeId: id,
          occurredAt: now,
          payload: { ...task, id, result, status, title: "Inspect regression" },
        })),
      });
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`command:inline-budget:${testCase.name}`),
        threadId,
        messageId,
        text: "Delegated tasks completed.",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
        delegatedCompletion: {
          parentRunId: runId,
          generation: 1,
          taskIds: [firstTaskId, secondTaskId],
        },
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      const message = projection.messages.find((candidate) => candidate.id === messageId)!;
      assert.equal(message.text.includes(testCase.first), testCase.inlineFirst);
      assert.equal(message.text.includes(testCase.second), testCase.inlineSecond);
      const deferredTaskId = testCase.inlineFirst ? secondTaskId : firstTaskId;
      assert.include(
        message.text,
        `Delegated task ${deferredTaskId} (Inspect regression) [${testCase.inlineFirst ? "cancelled" : "failed"}]`,
      );
      assert.include(message.text, `args: {taskId: "${deferredTaskId}"}`);
      assert.deepEqual(message.delegatedCompletion?.taskIds, [firstTaskId, secondTaskId]);
      assert.equal(
        projection.subagents.find((candidate) => candidate.id === deferredTaskId)?.result,
        testCase.inlineFirst ? testCase.second : testCase.first,
      );
    }),
  );

  it.effect("does not re-offer when wake-policy upgrades after delivered ownership settled", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:delegated-delivery-a1");
      const projectId = ProjectId.make("project:delegated-delivery-a1");
      const runId = RunId.make("run:delegated-delivery-a1");
      const rootNodeId = NodeId.make("node:delegated-delivery-a1-root");
      const taskId = NodeId.make("node:delegated-delivery-a1-task");

      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId,
        deliveryState: "delivered",
        completionWake: "settled_only",
        now,
      });

      const upgrade = yield* orchestrator.dispatch({
        type: "delegated_task.wake-policy",
        commandId: CommandId.make("command:delegated-delivery-a1:wake-policy"),
        parentThreadId: threadId,
        taskId,
        completionWake: "always",
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      const task = projection.subagents.find((candidate) => candidate.id === taskId);
      const parentRun = projection.runs.find((candidate) => candidate.id === runId);

      assert.equal(task?.completionWake, "always");
      assert.deepEqual(task?.completionDelivery, {
        state: "delivered",
        observedByRunId: null,
      });
      assert.deepEqual(parentRun?.delegatedCompletion, {
        disposition: "open",
        nextGeneration: 2,
        delivery: null,
      });
      assert.isFalse(
        upgrade.storedEvents.some(
          (stored) =>
            stored.event.type === "subagent.updated" &&
            stored.event.payload.id === taskId &&
            stored.event.payload.completionDelivery?.state === "claimed",
        ),
      );
      assert.isFalse(
        upgrade.storedEvents.some(
          (stored) =>
            stored.event.type === "run.updated" &&
            stored.event.payload.id === runId &&
            stored.event.payload.delegatedCompletion?.delivery !== null &&
            stored.event.payload.delegatedCompletion?.delivery !== undefined,
        ),
      );
    }),
  );

  it.effect(
    "treats repeated acknowledge and dispose with distinct command IDs as successful no-ops",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:delegated-delivery-a2");
        const projectId = ProjectId.make("project:delegated-delivery-a2");
        const runId = RunId.make("run:delegated-delivery-a2");
        const rootNodeId = NodeId.make("node:delegated-delivery-a2-root");
        const taskId = NodeId.make("node:delegated-delivery-a2-task");

        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId,
          deliveryState: "delivered",
          completionWake: "always",
          now,
        });

        // Distinct command IDs mirror task_status vs goat_thread_read racing after
        // their shared read preflight saw delivered ownership.
        const firstAck = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-task-status"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });
        const secondAck = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-thread-read"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });

        const firstAckTask = firstAck.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        const secondAckTask = secondAck.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        assert.isDefined(firstAckTask);
        assert.isDefined(secondAckTask);
        if (
          firstAckTask?.event.type !== "subagent.updated" ||
          secondAckTask?.event.type !== "subagent.updated"
        ) {
          return yield* Effect.die(new Error("Acknowledge events missing."));
        }
        assert.equal(firstAckTask.event.payload.completionDelivery?.state, "acknowledged");
        assert.equal(secondAckTask.event.payload.completionDelivery?.state, "acknowledged");
        assert.deepEqual(
          secondAckTask.event.payload.completionDelivery,
          firstAckTask.event.payload.completionDelivery,
        );
        assert.deepEqual(
          secondAckTask.event.payload.updatedAt,
          firstAckTask.event.payload.updatedAt,
        );
        assert.equal(secondAck.storedEvents.length, 1);

        const afterAck = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterAck.subagents.find((candidate) => candidate.id === taskId)?.completionDelivery,
          {
            state: "acknowledged",
            observedByRunId: runId,
          },
        );

        const firstDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make("command:delegated-delivery-a2:dispose-task-status"),
          parentThreadId: threadId,
          taskId,
        });
        const secondDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make("command:delegated-delivery-a2:dispose-thread-read"),
          parentThreadId: threadId,
          taskId,
        });

        const firstDisposeTask = firstDispose.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        const secondDisposeTask = secondDispose.storedEvents.find(
          (stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.id === taskId,
        );
        assert.isDefined(firstDisposeTask);
        assert.isDefined(secondDisposeTask);
        if (
          firstDisposeTask?.event.type !== "subagent.updated" ||
          secondDisposeTask?.event.type !== "subagent.updated"
        ) {
          return yield* Effect.die(new Error("Dispose events missing."));
        }
        assert.equal(firstDisposeTask.event.payload.completionDelivery?.state, "disposed");
        assert.equal(secondDisposeTask.event.payload.completionDelivery?.state, "disposed");
        assert.deepEqual(
          secondDisposeTask.event.payload.completionDelivery,
          firstDisposeTask.event.payload.completionDelivery,
        );
        assert.equal(secondDispose.storedEvents.length, 1);

        const afterDispose = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterDispose.subagents.find((candidate) => candidate.id === taskId)?.completionDelivery,
          {
            state: "disposed",
            observedByRunId: null,
          },
        );

        const acknowledgeAfterDispose = yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:delegated-delivery-a2:ack-after-dispose"),
          parentThreadId: threadId,
          taskId,
          observedByRunId: runId,
        });
        const acknowledgedTask = acknowledgeAfterDispose.storedEvents.find(
          (stored) => stored.event.type === "subagent.updated",
        );
        if (acknowledgedTask?.event.type !== "subagent.updated") {
          return yield* Effect.die(new Error("Acknowledge-after-dispose event missing."));
        }
        assert.deepEqual(acknowledgedTask.event.payload.completionDelivery, {
          state: "disposed",
          observedByRunId: null,
        });
        assert.equal(acknowledgeAfterDispose.storedEvents.length, 1);

        const afterStaleAcknowledge = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          afterStaleAcknowledge.subagents.find((candidate) => candidate.id === taskId)
            ?.completionDelivery,
          {
            state: "disposed",
            observedByRunId: null,
          },
        );
      }),
  );

  it.effect.each([
    { command: "acknowledge", before: "running", after: "failed", capture: false },
    { command: "acknowledge", before: "waiting", after: "completed", capture: true },
    { command: "accept", before: "waiting", after: "completed", capture: true },
  ] as const)(
    "keeps a $after run that settled between $command's read and commit",
    ({ command, before, after, capture }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const race = `${command}-settle-race-${after}`;
        const threadId = ThreadId.make(`thread:${race}`);
        const runId = RunId.make(`run:${race}`);
        const taskId = NodeId.make(`node:${race}-task`);
        const checkpointId = CheckpointId.make(`checkpoint:${race}`);
        const messageId = MessageId.make(`message:delegated-delivery:${threadId}`);
        yield* seedParentWithTerminalTask({
          threadId,
          projectId: ProjectId.make(`project:${race}`),
          runId,
          rootNodeId: NodeId.make(`node:${race}-root`),
          taskId,
          deliveryState: "claimed",
          deliveryTaskIds: [taskId],
          now,
        });
        const parent = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:${race}-before`),
              type: "run.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: { ...parent, status: before },
            },
            {
              id: EventId.make(`event:${race}-message`),
              type: "message.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: {
                id: messageId,
                threadId,
                runId,
                nodeId: parent.rootNodeId,
                role: "user",
                text: "Background task finished",
                attachments: [],
                streaming: false,
                createdBy: "agent",
                creationSource: "server",
                createdAt: now,
                updatedAt: now,
                delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
              },
            },
          ],
        });
        const { delegatedCompletion: _cohort, ...settledRun } = parent;
        const commit = sink.commitCommand;
        let settled = false;
        yield* Effect.acquireUseRelease(
          Effect.sync(() =>
            vi.spyOn(sink, "commitCommand").mockImplementation((input) =>
              Effect.gen(function* () {
                if (
                  !settled &&
                  input.commandType ===
                    (command === "accept"
                      ? "notification.delivery.accept"
                      : "delegated_task.completion-delivery.acknowledge")
                ) {
                  settled = true;
                  // The provider turn ends (or its checkpoint lands) after the command read the run.
                  yield* commit({
                    commandId: CommandId.make(`command:${race}`),
                    threadId,
                    commandType: capture ? "checkpoint.capture" : "provider.event",
                    acceptedAt: now,
                    effects: [],
                    events: [
                      {
                        id: EventId.make(`event:${race}-settled`),
                        type: "run.updated",
                        threadId,
                        runId,
                        occurredAt: now,
                        payload: {
                          ...settledRun,
                          status: after,
                          completedAt: now,
                          checkpointId: capture ? checkpointId : null,
                        },
                      },
                    ],
                  });
                }
                return yield* commit(input);
              }),
            ),
          ),
          () =>
            orchestrator.dispatch(
              command === "accept"
                ? {
                    type: "notification.delivery.accept",
                    commandId: CommandId.make(`command:${race}:accept`),
                    threadId,
                    messageId,
                  }
                : {
                    type: "delegated_task.completion-delivery.acknowledge",
                    commandId: CommandId.make(`command:${race}:task-status`),
                    parentThreadId: threadId,
                    taskId,
                    observedByRunId: runId,
                  },
            ),
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        assert.isTrue(settled);
        const finished = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          finished.subagents.find((row) => row.id === taskId)?.completionDelivery?.state,
          command === "accept" ? "delivered" : "acknowledged",
        );
        const run = finished.runs.find((candidate) => candidate.id === runId)!;
        assert.deepEqual(
          { status: run.status, completedAt: run.completedAt, checkpointId: run.checkpointId },
          { status: after, completedAt: now, checkpointId: capture ? checkpointId : null },
        );
      }),
  );
});

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))(
  "subagent follow-ups",
  (it) => {
    it.effect("keeps a checkpoint completion committed between finalize's read and write", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:completion-capture-race");
        const projectId = ProjectId.make("project:completion-capture-race");
        const runId = RunId.make("run:completion-capture-race");
        const rootNodeId = NodeId.make("node:completion-capture-race");
        const checkpointId = CheckpointId.make("checkpoint:completion-capture-race");
        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId: NodeId.make("node:completion-capture-seed"),
          deliveryState: "acknowledged",
          now,
        });
        const parent = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
        const waiting = { ...parent, status: "waiting" as const };
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:completion-capture-waiting"),
              type: "run.updated",
              threadId,
              runId,
              occurredAt: now,
              payload: waiting,
            },
          ],
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name: "completion-capture-child",
          completionWake: "always",
          continuationPending: false,
          runStatus: "completed",
          now,
        });
        const write = sink.writeWithEffects;
        let captured = false;
        const committedParentRuns: Array<OrchestrationV2Run> = [];
        yield* Effect.acquireUseRelease(
          Effect.sync(() =>
            vi.spyOn(sink, "writeWithEffects").mockImplementation((input) =>
              Effect.gen(function* () {
                if (
                  !captured &&
                  input.events.some(
                    (event) =>
                      event.type === "run.updated" &&
                      event.payload.id === runId &&
                      event.payload.delegatedCompletion?.delivery != null,
                  )
                ) {
                  captured = true;
                  // Commit capture after finalize planned its stale waiting snapshot.
                  const { delegatedCompletion: _cohort, ...captureRun } = waiting;
                  yield* sink.commitCommand({
                    commandId: CommandId.make("command:completion-capture-race"),
                    threadId,
                    commandType: "checkpoint.capture",
                    acceptedAt: now,
                    effects: [],
                    events: [
                      {
                        id: EventId.make("event:completion-capture-completed"),
                        type: "run.updated",
                        threadId,
                        runId,
                        occurredAt: now,
                        payload: {
                          ...captureRun,
                          status: "completed",
                          completedAt: now,
                          checkpointId,
                        },
                      },
                    ],
                  });
                }
                const stored = yield* write(input);
                for (const { event } of stored) {
                  if (event.type === "run.updated" && event.payload.id === runId) {
                    committedParentRuns.push(event.payload);
                  }
                }
                return stored;
              }),
            ),
          ),
          () => orchestrator.recoverDelegatedTasks,
          (spy) => Effect.sync(() => spy.mockRestore()),
        );
        assert.isTrue(captured);
        assert.equal(committedParentRuns.length, 1);
        const committedParentRun = committedParentRuns[0];
        assert.equal(committedParentRun?.status, "completed");
        assert.deepEqual(committedParentRun?.completedAt, now);
        assert.equal(committedParentRun?.checkpointId, checkpointId);
        assert.deepEqual(committedParentRun?.delegatedCompletion?.delivery?.taskIds, [
          child.taskId,
        ]);
        const finished = yield* orchestrator.getThreadProjection(threadId);
        const completed = finished.runs.find((run) => run.id === runId)!;
        assert.equal(completed.status, "completed");
        assert.deepEqual(completed.completedAt, now);
        assert.equal(completed.checkpointId, checkpointId);
        assert.deepEqual(completed.delegatedCompletion?.delivery?.taskIds, [child.taskId]);
        const wake = yield* requests.take;
        assert.equal(wake.delegatedCompletion?.parentRunId, runId);
        const delivery = completed.delegatedCompletion!.delivery!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "server",
          commandId: CommandId.make("command:completion-capture-delivery"),
          threadId,
          messageId: delivery.messageId,
          text: "Child finished",
          attachments: [],
          delegatedCompletion: {
            parentRunId: runId,
            generation: delivery.generation,
            taskIds: delivery.taskIds,
          },
          dispatchMode: { type: "queue_after_active" },
        });
        const delivered = yield* orchestrator.getThreadProjection(threadId);
        const deliveryRun = delivered.runs.find((run) => run.userMessageId === delivery.messageId);
        assert.isDefined(deliveryRun);
        assert.notEqual(deliveryRun?.status, "queued");
      }),
    );
    it.effect("pauses queued follow-up cards and resumes them", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const parentThreadId = ThreadId.make("thread:held-followup-parent");
        const projectId = ProjectId.make("project:held-followup");
        const parentRunId = RunId.make("run:held-followup-parent");
        const rootNodeId = NodeId.make("node:held-followup-parent");
        yield* seedParentWithTerminalTask({
          threadId: parentThreadId,
          projectId,
          runId: parentRunId,
          rootNodeId,
          taskId: NodeId.make("node:held-followup-seed"),
          deliveryState: "acknowledged",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId,
          projectId,
          parentRunId,
          rootNodeId,
          name: "held-followup-child",
          completionWake: "always",
          continuationPending: false,
          runStatus: "completed",
          now,
        });
        yield* orchestrator.recoverDelegatedTasks;
        const send = (name: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "agent",
            creationSource: "mcp",
            commandId: CommandId.make(`command:held-followup:${name}`),
            threadId: child.childThreadId,
            senderThreadId: parentThreadId,
            messageId: MessageId.make(`message:held-followup:${name}`),
            text: name,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
          });
        yield* send("active");
        yield* send("queued");
        const before = yield* orchestrator.getThreadProjection(child.childThreadId);
        const active = before.runs.find((run) => run.ordinal === 2)!;
        const queued = before.runs.find((run) => run.ordinal === 3)!;
        assert.equal(queued.status, "queued");
        const waitForStatus = (afterSequence: number, status: string) =>
          eventSink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "subagent.updated" &&
                stored.event.payload.id === queued.delegatedTaskId &&
                stored.event.payload.status === status,
            ),
            Stream.take(1),
            Stream.runHead,
          );
        const afterSequence = yield* eventSink.latestSequence();
        yield* orchestrator.dispatch({
          type: "thread.stop",
          threadId: child.childThreadId,
          commandId: CommandId.make("command:held-followup:stop"),
        });
        yield* waitForStatus(afterSequence, "idle");
        const paused = yield* orchestrator.getThreadProjection(parentThreadId);
        const task = paused.subagents.find((row) => row.id === queued.delegatedTaskId)!;
        assert.equal(task.status, "idle");
        assert.isNull(task.result);
        assert.equal(paused.nodes.find((row) => row.id === task.id)?.status, "idle");
        assert.equal(
          paused.turnItems.find((row) => row.type === "subagent" && row.subagentId === task.id)
            ?.status,
          "idle",
        );
        const endedSequence = yield* eventSink.latestSequence();
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("event:held-followup-active-ended"),
              type: "run.updated",
              threadId: child.childThreadId,
              runId: active.id,
              occurredAt: now,
              payload: { ...active, status: "interrupted", startedAt: now, completedAt: now },
            },
          ],
        });
        const activeTask = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
          (row) => row.id === active.delegatedTaskId,
        )!;
        if (activeTask.result === null) {
          yield* eventSink
            .stream({ afterSequence: endedSequence, eventType: "subagent.updated" })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.id === active.delegatedTaskId &&
                  stored.event.payload.status === "interrupted",
              ),
              Stream.take(1),
              Stream.runHead,
            );
        }
        const shell = (yield* orchestrator.getShellSnapshot()).threads.find(
          (row) => row.id === parentThreadId,
        )!;
        assert.isFalse((shell.pendingBackgroundTasks ?? []).some((row) => row.taskId === task.id));
        const resumeSequence = yield* eventSink.latestSequence();
        yield* orchestrator.dispatch({
          type: "queue.resume",
          threadId: child.childThreadId,
          commandId: CommandId.make("command:held-followup:resume"),
        });
        yield* waitForStatus(resumeSequence, "running");
        const resumed = yield* orchestrator.getThreadProjection(parentThreadId);
        assert.equal(resumed.subagents.find((row) => row.id === task.id)?.status, "running");
        assert.isNull(resumed.subagents.find((row) => row.id === task.id)?.result);
      }),
    );

    it.effect("delivers the run a background command's wake starts after the original result", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const now = yield* DateTime.now;
        const parentThreadId = ThreadId.make("thread:background-wake-parent");
        const projectId = ProjectId.make("project:background-wake");
        const parentRunId = RunId.make("run:background-wake-parent");
        const rootNodeId = NodeId.make("node:background-wake-parent");
        yield* seedParentWithTerminalTask({
          threadId: parentThreadId,
          projectId,
          runId: parentRunId,
          rootNodeId,
          taskId: NodeId.make("node:background-wake-seed"),
          deliveryState: "acknowledged",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId,
          projectId,
          parentRunId,
          rootNodeId,
          name: "background-wake-child",
          completionWake: "always",
          continuationPending: false,
          runStatus: "completed",
          now,
        });
        yield* orchestrator.recoverDelegatedTasks;
        let firstWake = yield* requests.take;
        while (firstWake.threadId !== parentThreadId) firstWake = yield* requests.take;
        yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: CommandId.make("command:background-wake-ack"),
          parentThreadId,
          taskId: child.taskId,
          observedByRunId: parentRunId,
        });
        const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.find(
          (run) => run.id === parentRunId,
        )!;
        yield* eventSink.write({
          commandId: reconcileCommandId("background-wake-parent-finished"),
          events: [
            {
              id: EventId.make("event:background-wake-parent-finished"),
              type: "run.updated",
              threadId: parentThreadId,
              runId: parentRunId,
              occurredAt: now,
              payload: { ...parentRun, status: "completed", completedAt: now },
            },
          ],
        });

        // The shape ProviderContinuationService dispatches when the provider
        // reports a background command (wire kind `background_command`) ended.
        const wakeMessageId = MessageId.make("message:background-wake");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "provider",
          commandId: CommandId.make("command:background-wake"),
          threadId: child.childThreadId,
          messageId: wakeMessageId,
          text: "Background activity updated",
          notification: {
            source: { kind: "command" },
            outcome: "completed",
            summary: 'Command "sleep 60" finished',
          },
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
        });
        const run = (yield* orchestrator.getThreadProjection(child.childThreadId)).runs.find(
          (row) => row.userMessageId === wakeMessageId,
        )!;
        assert.isDefined(run.delegatedTaskId);
        yield* eventSink.write({
          commandId: reconcileCommandId("background-wake-finished"),
          events: [
            {
              id: EventId.make("event:background-wake-result"),
              type: "message.updated",
              threadId: child.childThreadId,
              runId: run.id,
              occurredAt: now,
              payload: {
                id: MessageId.make("message:background-wake-result"),
                threadId: child.childThreadId,
                runId: run.id,
                nodeId: null,
                role: "assistant",
                text: "The background command finished cleanly.",
                attachments: [],
                streaming: false,
                createdBy: "agent",
                creationSource: "server",
                createdAt: now,
                updatedAt: now,
              },
            },
            {
              id: EventId.make("event:background-wake-finished"),
              type: "run.updated",
              threadId: child.childThreadId,
              runId: run.id,
              occurredAt: now,
              payload: { ...run, status: "completed", startedAt: now, completedAt: now },
            },
          ],
        });
        yield* orchestrator.recoverDelegatedTasks;
        const followup = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
          (task) => task.id === run.delegatedTaskId,
        )!;
        assert.equal(followup.status, "completed");
        assert.equal(followup.result, "The background command finished cleanly.");
        assert.equal(followup.completionDelivery?.state, "claimed");
        let wake = yield* requests.take;
        while (
          wake.threadId !== parentThreadId ||
          wake.delegatedCompletion?.messageId === firstWake.delegatedCompletion?.messageId
        ) {
          wake = yield* requests.take;
        }
        assert.equal(wake.delegatedCompletion?.parentRunId, parentRunId);
      }),
    );

    it.effect.each(["always", "settled_only"] as const)(
      "delivers a continued review round's result to its parent, wake %s",
      (wake) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const now = yield* DateTime.now;
          const name = "continued-review-" + wake;
          const parentThreadId = ThreadId.make("thread:" + name);
          const parentRunId = RunId.make("run:" + name);
          const rootNodeId = NodeId.make("node:" + name);
          yield* seedParentWithTerminalTask({
            threadId: parentThreadId,
            projectId: ProjectId.make("project:" + name),
            runId: parentRunId,
            rootNodeId,
            taskId: NodeId.make("node:seed-" + name),
            deliveryState: "acknowledged",
            now,
          });
          const child = yield* seedRestartCancelledChild({
            parentThreadId,
            projectId: ProjectId.make("project:" + name),
            parentRunId,
            rootNodeId,
            name: name + "-child",
            completionWake: "always",
            continuationPending: false,
            runStatus: "completed",
            now,
          });
          yield* orchestrator.recoverDelegatedTasks;
          let firstWake = yield* requests.take;
          while (firstWake.threadId !== parentThreadId) firstWake = yield* requests.take;
          yield* orchestrator.dispatch({
            type: "delegated_task.completion-delivery.acknowledge",
            commandId: CommandId.make("command:ack-" + name),
            parentThreadId,
            taskId: child.taskId,
            observedByRunId: parentRunId,
          });
          // The seeded task becomes a finished review round whose brief completed on native-1.
          const seeded = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
            (task) => task.id === child.taskId,
          )!;
          const childRun = (yield* orchestrator.getThreadProjection(child.childThreadId)).runs[0]!;
          const providerThreadId = ProviderThreadId.make("provider-thread:" + name);
          const attemptId = RunAttemptId.make("attempt:" + name);
          yield* eventSink.write({
            commandId: reconcileCommandId(name + "-round-1"),
            events: [
              {
                id: EventId.make("event:" + name + ":parent-root"),
                type: "node.updated",
                threadId: parentThreadId,
                runId: parentRunId,
                nodeId: rootNodeId,
                occurredAt: now,
                payload: {
                  id: rootNodeId,
                  threadId: parentThreadId,
                  runId: parentRunId,
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
                id: EventId.make("event:" + name + ":review"),
                type: "subagent.updated",
                threadId: parentThreadId,
                runId: parentRunId,
                nodeId: child.taskId,
                occurredAt: now,
                payload: {
                  ...seeded,
                  role: "review",
                  model: modelSelection.model,
                  modelSelection,
                  status: "completed",
                  result: "Round 1 findings",
                  completedAt: now,
                },
              },
              {
                id: EventId.make("event:" + name + ":provider-thread"),
                type: "provider-thread.updated",
                threadId: child.childThreadId,
                occurredAt: now,
                payload: {
                  id: providerThreadId,
                  driver,
                  providerInstanceId: modelSelection.instanceId,
                  providerSessionId: null,
                  appThreadId: child.childThreadId,
                  ownerNodeId: null,
                  nativeThreadRef: { driver, nativeId: "native-1", strength: "strong" },
                  nativeConversationHeadRef: null,
                  status: "idle",
                  firstRunOrdinal: 1,
                  lastRunOrdinal: 1,
                  handoffIds: [],
                  forkedFrom: null,
                  pendingBackgroundTasks: [],
                  contextUsage: null,
                  nativeMetadata: null,
                  goal: null,
                  createdAt: now,
                  updatedAt: now,
                },
              },
              {
                id: EventId.make("event:" + name + ":attempt"),
                type: "run-attempt.updated",
                threadId: child.childThreadId,
                runId: childRun.id,
                occurredAt: now,
                payload: {
                  id: attemptId,
                  nativeThreadId: "native-1",
                  runId: childRun.id,
                  attemptOrdinal: 1,
                  rootNodeId: NodeId.make("node:" + name + ":child-root"),
                  providerInstanceId: modelSelection.instanceId,
                  providerThreadId,
                  providerTurnId: null,
                  reason: "initial",
                  status: "completed",
                  startedAt: now,
                  completedAt: now,
                },
              },
              {
                id: EventId.make("event:" + name + ":turn"),
                type: "provider-turn.updated",
                threadId: child.childThreadId,
                runId: childRun.id,
                occurredAt: now,
                payload: {
                  id: ProviderTurnId.make("turn:" + name),
                  providerThreadId,
                  nodeId: NodeId.make("node:" + name + ":child-root"),
                  runAttemptId: attemptId,
                  nativeTurnRef: null,
                  ordinal: 1,
                  status: "completed",
                  startedAt: now,
                  completedAt: now,
                },
              },
            ],
          });
          const commandId = CommandId.make("command:continue-" + name);
          yield* orchestrator.dispatch({
            type: "delegated_task.review-continue",
            commandId,
            threadId: parentThreadId,
            parentRunId,
            parentNodeId: rootNodeId,
            continueFrom: child.taskId,
            childThreadId: child.childThreadId,
            task: "Round 2: re-check the fix.",
            modelSelection,
            completionWake: wake,
            memoryGrantCeiling: "none",
            createdBy: "agent",
            creationSource: "mcp",
          });
          const taskId = derive.delegatedTaskNode({ commandId });
          const run = (yield* orchestrator.getThreadProjection(child.childThreadId)).runs.find(
            (row) => row.delegatedTaskId === taskId,
          )!;
          const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.find(
            (row) => row.id === parentRunId,
          )!;
          yield* eventSink.write({
            commandId: reconcileCommandId(name + "-finish"),
            events: [
              {
                id: EventId.make("event:" + name + ":parent-finished"),
                type: "run.updated",
                threadId: parentThreadId,
                runId: parentRunId,
                occurredAt: now,
                payload: { ...parentRun, status: "completed", completedAt: now },
              },
              {
                id: EventId.make("event:" + name + ":round-2-finished"),
                type: "run.updated",
                threadId: child.childThreadId,
                runId: run.id,
                occurredAt: now,
                payload: { ...run, status: "completed", startedAt: now, completedAt: now },
              },
            ],
          });
          yield* orchestrator.recoverDelegatedTasks;
          const finished = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents;
          const round = finished.find((task) => task.id === taskId)!;
          assert.deepInclude(round, {
            role: "review",
            continuedFrom: child.taskId,
            status: "completed",
          });
          assert.equal(round.completionDelivery?.state, "claimed");
          let next = yield* requests.take;
          while (
            next.threadId !== parentThreadId ||
            next.delegatedCompletion?.messageId === firstWake.delegatedCompletion?.messageId
          )
            next = yield* requests.take;
          assert.equal(next.delegatedCompletion?.parentRunId, parentRunId);
        }),
    );

    const outcomes = [
      "completed",
      "failed",
      "interrupted",
      "restarted",
      "stopped",
      "overlapping",
    ] as const;
    it.effect.each(outcomes)(
      "delivers a %s follow-up independently of the original task",
      (outcome) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const now = yield* DateTime.now;
          const parentThreadId = ThreadId.make(`thread:followup-${outcome}`);
          const projectId = ProjectId.make(`project:followup-${outcome}`);
          const parentRunId = RunId.make(`run:followup-${outcome}`);
          const rootNodeId = NodeId.make(`node:followup-${outcome}`);
          yield* seedParentWithTerminalTask({
            threadId: parentThreadId,
            projectId,
            runId: parentRunId,
            rootNodeId,
            taskId: NodeId.make(`node:seed-${outcome}`),
            deliveryState: "acknowledged",
            now,
          });
          const child = yield* seedRestartCancelledChild({
            parentThreadId,
            projectId,
            parentRunId,
            rootNodeId,
            name: `followup-child-${outcome}`,
            completionWake: "always",
            continuationPending: false,
            runStatus: "completed",
            now,
          });
          yield* orchestrator.recoverDelegatedTasks;
          let firstWake = yield* requests.take;
          while (firstWake.threadId !== parentThreadId) firstWake = yield* requests.take;
          assert.equal(firstWake.delegatedCompletion?.parentRunId, parentRunId);
          yield* orchestrator.dispatch({
            type: "delegated_task.completion-delivery.acknowledge",
            commandId: CommandId.make(`command:followup-ack-${outcome}`),
            parentThreadId,
            taskId: child.taskId,
            observedByRunId: parentRunId,
          });
          const original = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
            (task) => task.id === child.taskId,
          )!;
          const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.find(
            (run) => run.id === parentRunId,
          )!;
          yield* eventSink.write({
            commandId: reconcileCommandId(`followup-parent-finished-${outcome}`),
            events: [
              {
                id: EventId.make(`event:followup-parent-finished-${outcome}`),
                type: "run.updated",
                threadId: parentThreadId,
                runId: parentRunId,
                occurredAt: now,
                payload: { ...parentRun, status: "completed", completedAt: now },
              },
            ],
          });
          const messageId = MessageId.make(`message:followup-${outcome}`);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: outcome === "failed" ? "user" : "agent",
            creationSource: outcome === "failed" ? "web" : "mcp",
            commandId: CommandId.make(`command:followup-send-${outcome}`),
            threadId: child.childThreadId,
            senderThreadId: parentThreadId,
            messageId,
            text: "Check the same work again.",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
          });
          const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
          let run = childProjection.runs.find((row) => row.userMessageId === messageId)!;
          assert.isDefined(run.delegatedTaskId);
          const workingParent = yield* orchestrator.getShellSnapshot();
          const backgroundTask = workingParent.threads
            .find((thread) => thread.id === parentThreadId)
            ?.pendingBackgroundTasks?.find((task) => task.kind === "subagent");
          assert.equal(backgroundTask?.childThreadId, child.childThreadId);
          if (outcome === "overlapping") {
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "mcp",
              commandId: CommandId.make("command:overlapping-followup"),
              threadId: child.childThreadId,
              senderThreadId: parentThreadId,
              messageId: MessageId.make("message:overlapping-followup"),
              text: "Keep working on another follow-up.",
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
            });
          }
          if (outcome === "restarted") {
            const cut = { ...run, status: "cancelled" as const, startedAt: now, completedAt: now };
            yield* eventSink.writeWithEffects({
              commandId: reconcileCommandId("followup-restart-cut"),
              events: [
                {
                  id: EventId.make("event:followup-restart-cut"),
                  type: "run.updated",
                  threadId: child.childThreadId,
                  runId: run.id,
                  occurredAt: now,
                  payload: cut,
                },
              ],
              effects: [
                {
                  id: `effect:restart-continuation:${run.id}`,
                  commandId: reconcileCommandId("followup-restart-cut"),
                  threadId: child.childThreadId,
                  request: { type: "provider-runtime.continue", sourceRunId: run.id },
                },
              ],
            });
            yield* orchestrator.recoverDelegatedTasks;
            assert.isNull(
              (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
                (task) => task.id === run.delegatedTaskId,
              )!.result,
            );
            const continuationMessageId = MessageId.make("message:followup-restart-continuation");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:followup-restart-continuation"),
              threadId: child.childThreadId,
              restartContinuationOfRunId: run.id,
              messageId: continuationMessageId,
              text: "Continue where you left off.",
              attachments: [],
              dispatchMode: { type: "start_immediately" },
            });
            const continuation = (yield* orchestrator.getThreadProjection(
              child.childThreadId,
            )).runs.find((row) => row.userMessageId === continuationMessageId)!;
            assert.equal(continuation.delegatedTaskId, run.delegatedTaskId);
            run = continuation;
          }
          if (outcome === "stopped") {
            yield* orchestrator.dispatch({
              type: "thread.stop",
              threadId: parentThreadId,
              commandId: CommandId.make(`command:followup-stop-${outcome}`),
            });
          }
          yield* eventSink.write({
            commandId: reconcileCommandId(`followup-finish-${outcome}`),
            events: [
              {
                id: EventId.make(`event:followup-finish-${outcome}`),
                type: "run.updated",
                threadId: child.childThreadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  ...run,
                  status:
                    outcome === "stopped"
                      ? "interrupted"
                      : outcome === "restarted" || outcome === "overlapping"
                        ? "completed"
                        : outcome,
                  startedAt: now,
                  completedAt: now,
                },
              },
            ],
          });
          yield* orchestrator.recoverDelegatedTasks;
          const finished = yield* orchestrator.getThreadProjection(parentThreadId);
          assert.deepEqual(
            finished.subagents.find((task) => task.id === child.taskId),
            original,
          );
          const followup = finished.subagents.find((task) => task.id === run.delegatedTaskId)!;
          if (outcome === "overlapping") {
            const later = finished.subagents.find(
              (task) =>
                task.childThreadId === child.childThreadId &&
                task.id !== child.taskId &&
                task.id !== followup.id,
            )!;
            assert.equal(later.status, "pending");
            assert.isNull(later.result);
          }
          assert.equal(
            followup.status,
            outcome === "stopped"
              ? "interrupted"
              : outcome === "restarted" || outcome === "overlapping"
                ? "completed"
                : outcome,
          );
          assert.equal(
            followup.completionDelivery?.state,
            outcome === "stopped" ? "disposed" : "claimed",
          );
          if (outcome !== "stopped") {
            let wake = yield* requests.take;
            while (
              wake.threadId !== parentThreadId ||
              wake.delegatedCompletion?.messageId === firstWake.delegatedCompletion?.messageId
            ) {
              wake = yield* requests.take;
            }
            assert.equal(wake.delegatedCompletion?.parentRunId, parentRunId);
            assert.notEqual(
              wake.delegatedCompletion?.messageId,
              firstWake.delegatedCompletion?.messageId,
            );
          }
          assert.equal(
            finished.contextTransfers.filter(
              (transfer) =>
                transfer.type === "subagent_result" &&
                transfer.sourceThreadId === child.childThreadId,
            ).length,
            2,
          );
          yield* orchestrator.recoverDelegatedTasks;
          const recovered = yield* orchestrator.getThreadProjection(parentThreadId);
          assert.equal(recovered.contextTransfers.length, finished.contextTransfers.length);
          if (outcome === "completed") {
            const automaticMessageId = MessageId.make("message:followup-automatic-wake");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              createdBy: "agent",
              creationSource: "server",
              commandId: CommandId.make("command:followup-automatic-wake"),
              threadId: child.childThreadId,
              messageId: automaticMessageId,
              text: "A monitor reported new output.",
              attachments: [],
              notification: {
                source: { kind: "monitor" },
                outcome: "updated",
                summary: "Monitor updated",
              },
              dispatchMode: { type: "queue_after_active" },
            });
            const automatic = (yield* orchestrator.getThreadProjection(
              child.childThreadId,
            )).runs.find((run) => run.userMessageId === automaticMessageId)!;
            assert.isUndefined(automatic.delegatedTaskId);
            yield* eventSink.write({
              commandId: reconcileCommandId("followup-automatic-finished"),
              events: [
                {
                  id: EventId.make("event:followup-automatic-finished"),
                  type: "run.updated",
                  threadId: child.childThreadId,
                  runId: automatic.id,
                  occurredAt: now,
                  payload: { ...automatic, status: "completed", startedAt: now, completedAt: now },
                },
              ],
            });
            yield* orchestrator.recoverDelegatedTasks;
            const afterAutomatic = yield* orchestrator.getThreadProjection(parentThreadId);
            assert.deepEqual(afterAutomatic.subagents, recovered.subagents);
            assert.equal(afterAutomatic.contextTransfers.length, recovered.contextTransfers.length);
            const control = yield* seedRestartCancelledChild({
              parentThreadId,
              projectId,
              parentRunId,
              rootNodeId,
              name: "followup-control-child",
              completionWake: "always",
              continuationPending: false,
              runStatus: "completed",
              now,
            });
            yield* orchestrator.recoverDelegatedTasks;
            const afterControl = yield* orchestrator.getThreadProjection(parentThreadId);
            assert.equal(
              afterControl.subagents.find((task) => task.id === control.taskId)?.completionDelivery
                ?.state,
              "claimed",
            );
            assert.equal(
              afterControl.contextTransfers.filter(
                (transfer) =>
                  transfer.type === "subagent_result" &&
                  transfer.sourceThreadId === control.childThreadId,
              ).length,
              1,
            );
          }
        }),
    );

    it.effect("serializes a recovered child answer with its parent and tracks the follow-up", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const parentThreadId = ThreadId.make("thread:question-answer-parent");
        const projectId = ProjectId.make("project:question-answer");
        const parentRunId = RunId.make("run:question-answer-parent");
        const rootNodeId = NodeId.make("node:question-answer-parent");
        yield* seedParentWithTerminalTask({
          threadId: parentThreadId,
          projectId,
          runId: parentRunId,
          rootNodeId,
          taskId: NodeId.make("node:question-answer-seed"),
          deliveryState: "acknowledged",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId,
          projectId,
          parentRunId,
          rootNodeId,
          name: "question-answer-child",
          completionWake: "always",
          continuationPending: false,
          now,
        });
        // The cancelled result is published before anyone answers the question.
        yield* orchestrator.recoverDelegatedTasks;
        assert.isNotNull(
          (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
            (task) => task.id === child.taskId,
          )?.result,
        );
        const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.find(
          (run) => run.id === parentRunId,
        )!;
        yield* eventSink.write({
          events: [
            {
              id: EventId.make("event:question-answer-parent-completed"),
              type: "run.updated",
              threadId: parentThreadId,
              runId: parentRunId,
              occurredAt: now,
              payload: { ...parentRun, status: "completed", completedAt: now },
            },
          ],
        });
        const requestId = RuntimeRequestId.make("request:question-answer");
        const nodeId = NodeId.make("node:question-answer-request");
        yield* eventSink.write({
          commandId: CommandId.make("command:seed-question-answer"),
          events: [
            {
              id: EventId.make("event:question-answer-request"),
              type: "runtime-request.updated",
              threadId: child.childThreadId,
              nodeId,
              occurredAt: now,
              payload: {
                id: requestId,
                nodeId,
                providerTurnId: null,
                nativeRequestRef: null,
                kind: "user_input",
                status: "pending",
                responseCapability: { type: "message" },
                createdAt: now,
                resolvedAt: null,
              },
            },
            {
              id: EventId.make("event:question-answer-item"),
              type: "turn-item.updated",
              threadId: child.childThreadId,
              nodeId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make("turn-item:question-answer"),
                type: "user_input_request",
                threadId: child.childThreadId,
                runId: child.childRunId,
                nodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "waiting",
                title: null,
                startedAt: now,
                completedAt: null,
                updatedAt: now,
                requestId,
                questions: [
                  { id: "color", header: "Color", question: "Which color?", options: [] },
                ],
              },
            },
          ],
        });

        const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
        const parentHeld = yield* Deferred.make<void>();
        const releaseParent = yield* Deferred.make<void>();
        const answerWaiting = yield* Deferred.make<void>();
        const withLock = executor.withLock;
        const parentMutation = yield* withLock(
          parentThreadId,
          Deferred.succeed(parentHeld, undefined).pipe(
            Effect.andThen(Deferred.await(releaseParent)),
          ),
        ).pipe(Effect.forkScoped({ startImmediately: true }));
        yield* Deferred.await(parentHeld);
        const observeLock: ThreadCommandExecutor.ThreadCommandExecutor["Service"]["withLock"] = (
          key,
          effect,
        ) =>
          key === parentThreadId
            ? Deferred.succeed(answerWaiting, undefined).pipe(Effect.andThen(withLock(key, effect)))
            : withLock(key, effect);
        const spy = vi.spyOn(executor, "withLock").mockImplementation(observeLock);
        yield* Effect.gen(function* () {
          const answer = yield* orchestrator
            .dispatch({
              type: "runtime-request.respond",
              commandId: CommandId.make("command:question-answer"),
              threadId: child.childThreadId,
              requestId,
              answers: { color: "Blue" },
            })
            .pipe(Effect.forkScoped({ startImmediately: true }));
          yield* Effect.raceFirst(Deferred.await(answerWaiting), Fiber.join(answer));
          const waiting = yield* orchestrator.getThreadProjection(child.childThreadId);
          assert.equal(
            waiting.runtimeRequests.find((row) => row.id === requestId)?.status,
            "pending",
          );
          assert.isFalse((yield* executor.activeKeys).includes(child.childThreadId));
          yield* Deferred.succeed(releaseParent, undefined);
          yield* Fiber.join(parentMutation);
          yield* Fiber.join(answer);
        }).pipe(Effect.ensuring(Effect.sync(() => spy.mockRestore())));

        const answerRun = (yield* orchestrator.getThreadProjection(child.childThreadId)).runs.find(
          (run) => run.userMessageId === MessageId.make(`async-answer:${requestId}`),
        );
        assert.isDefined(answerRun?.delegatedTaskId);
        const followup = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
          (task) => task.id === answerRun?.delegatedTaskId,
        );
        assert.equal(followup?.childThreadId, child.childThreadId);
        assert.isNull(followup?.result);
        assert.isTrue(
          (yield* orchestrator.getThreadShell(parentThreadId))?.pendingBackgroundTasks?.some(
            (task) => task.kind === "subagent" && task.childThreadId === child.childThreadId,
          ),
        );
      }),
    );
  },
);
