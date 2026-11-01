import {
  reconcileCommandId,
  parentProviderThreadId,
  runEvent,
  seedRestartCancelledChild,
} from "./DelegatedCompletionDelivery.testkit.ts";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  modelSelection,
  driver,
  layerTest,
  seedParentWithTerminalTask,
} from "./DelegatedCompletionDelivery.testkit.ts";

it.layer(layerTest)("delegated background work across a server restart", (it) => {
  it.effect("settles a cancelled child whose held wakes wait behind it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:held-wake-parent");
      const projectId = ProjectId.make("project:held-wake-parent");
      const runId = RunId.make("run:held-wake-parent");
      const rootNodeId = NodeId.make("node:held-wake-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:held-wake-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "held-wake-child",
        completionWake: "always",
        continuationPending: false,
        now,
      });
      const held = runEvent({
        threadId: child.childThreadId,
        runId: RunId.make("run:held-wake-child:2"),
        ordinal: 2,
        status: "queued",
        now,
      });
      yield* eventSink.write({
        commandId: CommandId.make("command:held-wake-child:held"),
        events: [
          {
            ...held,
            payload: { ...held.payload, startedAt: null, completedAt: null, queueHeld: true },
          },
        ],
      });

      yield* orchestrator.recoverDelegatedTasks;

      const recovered = yield* orchestrator.getThreadProjection(threadId);
      const task = recovered.subagents.find((row) => row.id === child.taskId);
      assert.equal(task?.status, "cancelled");
      assert.isNotNull(task?.result ?? null);
      assert.isTrue(
        recovered.contextTransfers.some(
          (transfer) =>
            transfer.type === "subagent_result" && transfer.sourceThreadId === child.childThreadId,
        ),
      );
      assert.isFalse(yield* orchestrator.delegatedTaskResultPending(child.childThreadId));
      const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
      assert.deepEqual(
        childProjection.runs.map((run) => [run.status, run.queueHeld ?? false]),
        [
          ["cancelled", false],
          ["queued", true],
        ],
      );
    }),
  );

  it.effect("settles a child whose provider failure holds its queued wakes", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:failed-hold-parent");
      const projectId = ProjectId.make("project:failed-hold-parent");
      const runId = RunId.make("run:failed-hold-parent");
      const rootNodeId = NodeId.make("node:failed-hold-parent-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:failed-hold-parent-settled"),
        deliveryState: "delivered",
        now,
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "failed-hold-child",
        completionWake: "always",
        continuationPending: false,
        now,
      });
      const activeRun = runEvent({
        threadId: child.childThreadId,
        runId: RunId.make("run:failed-hold-child:2"),
        ordinal: 2,
        status: "running",
        now,
      });
      const queued = runEvent({
        threadId: child.childThreadId,
        runId: RunId.make("run:failed-hold-child:3"),
        ordinal: 3,
        status: "queued",
        now,
      });
      yield* eventSink.write({
        commandId: CommandId.make("command:failed-hold-child:resumed"),
        events: [
          activeRun,
          { ...queued, payload: { ...queued.payload, startedAt: null, completedAt: null } },
        ],
      });
      const afterSequence = yield* eventSink.latestSequence();
      const errorItemId = TurnItemId.make("turn-item:failed-hold-child:error");
      yield* eventSink.write({
        commandId: CommandId.make("command:failed-hold-child:failed"),
        events: [
          {
            id: EventId.make("event:failed-hold-child:error"),
            type: "turn-item.updated",
            threadId: child.childThreadId,
            runId: activeRun.runId,
            providerInstanceId: modelSelection.instanceId,
            occurredAt: now,
            payload: {
              id: errorItemId,
              type: "error",
              threadId: child.childThreadId,
              runId: activeRun.runId,
              nodeId: null,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 1,
              status: "failed",
              title: "Provider failure",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "provider_error",
                message: "Provider failed.",
                code: "provider_failed",
                retryable: null,
              },
            },
          },
          {
            ...activeRun,
            id: EventId.make("event:failed-hold-child:failed"),
            payload: { ...activeRun.payload, status: "failed", completedAt: now },
          },
        ],
      });

      const settled = yield* eventSink
        .stream({ afterSequence, eventType: "subagent.updated" })
        .pipe(
          Stream.filter(
            (stored) =>
              stored.event.type === "subagent.updated" && stored.event.payload.id === child.taskId,
          ),
          Stream.take(1),
          Stream.runHead,
        );
      assert.isTrue(settled._tag === "Some");
      const recovered = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(recovered.subagents.find((row) => row.id === child.taskId)?.status, "failed");
      const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
      assert.deepEqual(
        childProjection.runs.map((run) => [run.status, run.queueHeld ?? false]),
        [
          ["cancelled", false],
          ["failed", false],
          ["queued", true],
        ],
      );
    }),
  );

  it.effect(
    "recovers an unpublished child failure after its completion delivery was disposed",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:unpublished-failure-parent");
        const projectId = ProjectId.make("project:unpublished-failure-parent");
        const runId = RunId.make("run:unpublished-failure-parent");
        const rootNodeId = NodeId.make("node:unpublished-failure-parent-root");
        yield* seedParentWithTerminalTask({
          threadId,
          projectId,
          runId,
          rootNodeId,
          taskId: NodeId.make("node:unpublished-failure-parent-settled"),
          deliveryState: "delivered",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId: threadId,
          projectId,
          parentRunId: runId,
          rootNodeId,
          name: "unpublished-failure-child",
          completionWake: "always",
          continuationPending: false,
          now,
        });
        // Skip the live terminal listener to model a committed failure whose
        // publication was interrupted. task_cancel then disposed its delivery.
        yield* eventSink.write({
          commandId: reconcileCommandId("unpublished-failure"),
          events: [
            runEvent({
              threadId: child.childThreadId,
              runId: child.childRunId,
              ordinal: 1,
              status: "failed",
              now,
            }),
          ],
        });
        yield* orchestrator.dispatch({
          type: "delegated_task.completion-delivery.dispose",
          commandId: CommandId.make("command:unpublished-failure-dispose"),
          parentThreadId: threadId,
          taskId: child.taskId,
        });
        yield* orchestrator.recoverDelegatedTasks;
        const recovered = yield* orchestrator.getThreadProjection(threadId);
        const task = recovered.subagents.find((row) => row.id === child.taskId);
        assert.equal(task?.status, "failed");
        assert.equal(task?.result, "Child task ended with status failed.");
        assert.equal(task?.completionDelivery?.state, "disposed");
        assert.lengthOf(recovered.runs, 1);
        assert.lengthOf(
          recovered.contextTransfers.filter((transfer) => transfer.type === "subagent_result"),
          1,
        );
        yield* orchestrator.recoverDelegatedTasks;
        assert.deepEqual(yield* orchestrator.getThreadProjection(threadId), recovered);
      }),
  );

  it.effect("wakes the parent for a settled_only task once its spawning turn ended", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:settled-only-restart");
      const projectId = ProjectId.make("project:settled-only-restart");
      const runId = RunId.make("run:settled-only-restart");
      const rootNodeId = NodeId.make("node:settled-only-restart-root");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId,
        runId,
        rootNodeId,
        taskId: NodeId.make("node:settled-only-restart-settled"),
        deliveryState: "delivered",
        now,
      });
      yield* eventSink.write({
        commandId: reconcileCommandId("settled-only-restart"),
        events: [
          runEvent({
            threadId,
            runId,
            ordinal: 1,
            status: "cancelled",
            now,
            providerThreadId: parentProviderThreadId(threadId),
            userMessageId: MessageId.make(`message:seed-user:${threadId}`),
            delegatedCompletion: { disposition: "open", nextGeneration: 2, delivery: null },
          }),
          runEvent({
            threadId,
            runId: RunId.make("run:settled-only-restart:continuation"),
            ordinal: 2,
            status: "running",
            now,
            providerThreadId: parentProviderThreadId(threadId),
          }),
        ],
      });
      const child = yield* seedRestartCancelledChild({
        parentThreadId: threadId,
        projectId,
        parentRunId: runId,
        rootNodeId,
        name: "settled-only-restart-child",
        completionWake: "settled_only",
        continuationPending: false,
        now,
      });

      yield* orchestrator.recoverDelegatedTasks;

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        projection.subagents.find((row) => row.id === child.taskId)?.completionDelivery?.state,
        "claimed",
      );
      assert.deepEqual(
        projection.runs.find((row) => row.id === runId)?.delegatedCompletion?.delivery?.taskIds,
        [child.taskId],
      );
    }),
  );

  it.effect.each(["a background command", "a nested subagent"] as const)(
    "finalizes a child whose run ended before %s settled",
    (blocker) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const key = blocker === "a background command" ? "command" : "nested";
        const threadId = ThreadId.make(`late-settle-parent-${key}`);
        const runId = RunId.make(`late-settle-parent-run-${key}`);
        const rootNodeId = NodeId.make(`late-settle-parent-root-${key}`);
        yield* seedParentWithTerminalTask({
          threadId,
          projectId: ProjectId.make(`late-settle-project-${key}`),
          runId,
          rootNodeId,
          taskId: NodeId.make(`late-settle-seed-task-${key}`),
          deliveryState: "acknowledged",
          now,
        });
        // A delegated child with a running task on the parent and a running run of its own.
        const delegate = (name: string) =>
          Effect.gen(function* () {
            const taskId = NodeId.make(`node:late-settle-${key}-${name}`);
            const childThreadId = ThreadId.make(`thread:late-settle-${key}-${name}`);
            const run = runEvent({
              threadId: childThreadId,
              runId: RunId.make(`run:late-settle-${key}-${name}`),
              ordinal: 1,
              status: "running",
              now,
            });
            yield* sink.write({
              events: [
                {
                  id: EventId.make(`event:late-settle-${key}-${name}:thread`),
                  type: "thread.created",
                  threadId: childThreadId,
                  occurredAt: now,
                  payload: {
                    createdBy: "agent",
                    creationSource: "server",
                    id: childThreadId,
                    projectId: ProjectId.make(`late-settle-project-${key}`),
                    title: name,
                    providerInstanceId: modelSelection.instanceId,
                    modelSelection,
                    runtimeMode: "full-access",
                    interactionMode: "default",
                    branch: null,
                    worktreePath: null,
                    activeProviderThreadId: null,
                    lineage: {
                      parentThreadId: threadId,
                      relationshipToParent: "subagent",
                      rootThreadId: threadId,
                    },
                    forkedFrom: { type: "node", nodeId: taskId },
                    createdAt: now,
                    updatedAt: now,
                    archivedAt: null,
                    settledOverride: null,
                    settledAt: null,
                    lastVisitedAt: null,
                    deletedAt: null,
                  },
                },
                {
                  id: EventId.make(`event:late-settle-${key}-${name}:task`),
                  type: "subagent.updated",
                  threadId,
                  runId,
                  nodeId: taskId,
                  driver,
                  providerInstanceId: modelSelection.instanceId,
                  occurredAt: now,
                  payload: {
                    id: taskId,
                    threadId,
                    runId,
                    parentNodeId: rootNodeId,
                    origin: "app_owned",
                    createdBy: "agent",
                    driver,
                    providerInstanceId: modelSelection.instanceId,
                    providerThreadId: null,
                    childThreadId,
                    nativeTaskRef: null,
                    prompt: `Run ${name}.`,
                    title: null,
                    model: null,
                    completionWake: "always",
                    status: "running",
                    result: null,
                    startedAt: now,
                    completedAt: null,
                    updatedAt: now,
                  },
                },
                run,
              ],
            });
            return { task: { id: taskId }, childThreadId, run: run.payload };
          });
        const settled = (taskId: NodeId, afterSequence: number) =>
          sink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
            Stream.filter(
              (stored) =>
                stored.event.type === "subagent.updated" &&
                stored.event.payload.id === taskId &&
                stored.event.payload.status === "completed",
            ),
            Stream.take(1),
            Stream.runDrain,
          );
        const blocked = yield* delegate("blocked");
        const barrier = yield* delegate("barrier");
        const providerThread = {
          id: ProviderThreadId.make(`provider-thread:late-settle-child-${key}`),
          driver,
          providerInstanceId: modelSelection.instanceId,
          providerSessionId: null,
          appThreadId: blocked.childThreadId,
          ownerNodeId: null,
          nativeThreadRef: null,
          nativeConversationHeadRef: null,
          status: "idle" as const,
          firstRunOrdinal: 1,
          lastRunOrdinal: 1,
          handoffIds: [],
          forkedFrom: null,
          createdAt: now,
          updatedAt: now,
        };
        const nested = {
          id: NodeId.make(`late-settle-nested-${key}`),
          threadId: blocked.childThreadId,
          runId: blocked.run.id,
          parentNodeId: NodeId.make(`late-settle-child-root-${key}`),
          origin: "provider_native" as const,
          createdBy: "agent" as const,
          driver,
          providerInstanceId: modelSelection.instanceId,
          providerThreadId: null,
          childThreadId: null,
          nativeTaskRef: null,
          prompt: "Nested work",
          title: null,
          model: null,
          status: "running" as const,
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        };
        const blockerEvent = (open: boolean) =>
          blocker === "a background command"
            ? {
                id: EventId.make(`event:late-settle-roster-${key}-${open}`),
                type: "provider-thread.updated" as const,
                threadId: blocked.childThreadId,
                driver,
                providerInstanceId: modelSelection.instanceId,
                occurredAt: now,
                payload: {
                  ...providerThread,
                  pendingBackgroundTasks: open
                    ? [{ taskId: "sleep-900", kind: "command" as const }]
                    : [],
                },
              }
            : {
                id: EventId.make(`event:late-settle-nested-${key}-${open}`),
                type: "subagent.updated" as const,
                threadId: blocked.childThreadId,
                runId: blocked.run.id,
                nodeId: nested.id,
                driver,
                providerInstanceId: modelSelection.instanceId,
                occurredAt: now,
                payload: open
                  ? nested
                  : { ...nested, status: "completed" as const, result: "done", completedAt: now },
              };
        const ended = (child: typeof blocked) => ({
          ...runEvent({
            threadId: child.childThreadId,
            runId: child.run.id,
            ordinal: child.run.ordinal,
            status: "completed",
            now,
          }),
          payload: { ...child.run, status: "completed" as const, startedAt: now, completedAt: now },
        });

        const beforeEnd = yield* sink.latestSequence();
        yield* sink.write({ events: [blockerEvent(true)] });
        yield* sink.write({ events: [ended(blocked)] });
        yield* sink.write({ events: [ended(barrier)] });
        // Run updates are handled in order, so the barrier settling means the blocked child's
        // run end was handled too, while its work still ran.
        yield* settled(barrier.task.id, beforeEnd);
        assert.equal(
          (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
            (task) => task.id === blocked.task.id,
          )?.status,
          "running",
        );

        const beforeSettle = yield* sink.latestSequence();
        yield* sink.write({ events: [blockerEvent(false)] });
        yield* settled(blocked.task.id, beforeSettle);
        const finished = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
          (task) => task.id === blocked.task.id,
        );
        assert.equal(finished?.status, "completed");
        assert.notEqual(finished?.completionDelivery?.state, "disposed");
      }),
  );
});
