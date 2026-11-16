import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, NodeId, ProjectId, RunId, ThreadId } from "@goat/contracts";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  driver,
  layerTest,
  modelSelection,
  reconcileCommandId,
  runEvent,
  seedParentWithTerminalTask,
  seedRestartCancelledChild,
} from "./DelegatedCompletionDelivery.testkit.ts";

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))(
  "delegated follow-up completion",
  (it) => {
    it.effect("holds a follow-up open while the child's own subagent still runs", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const parentThreadId = ThreadId.make("thread:followup-grandchild-parent");
        const projectId = ProjectId.make("project:followup-grandchild");
        const parentRunId = RunId.make("run:followup-grandchild-parent");
        const rootNodeId = NodeId.make("node:followup-grandchild-parent");
        yield* seedParentWithTerminalTask({
          threadId: parentThreadId,
          projectId,
          runId: parentRunId,
          rootNodeId,
          taskId: NodeId.make("node:followup-grandchild-seed"),
          deliveryState: "acknowledged",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId,
          projectId,
          parentRunId,
          rootNodeId,
          name: "followup-grandchild-child",
          completionWake: "always",
          continuationPending: false,
          runStatus: "completed",
          now,
        });
        yield* orchestrator.recoverDelegatedTasks;
        assert.equal(
          (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
            (task) => task.id === child.taskId,
          )?.status,
          "completed",
        );

        const followupMessageId = MessageId.make("message:followup-grandchild-send");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: CommandId.make("command:followup-grandchild-send"),
          threadId: child.childThreadId,
          senderThreadId: parentThreadId,
          messageId: followupMessageId,
          text: "Now delegate the next step.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
        });
        const followupRun = (yield* orchestrator.getThreadProjection(
          child.childThreadId,
        )).runs.find((run) => run.userMessageId === followupMessageId)!;
        assert.isDefined(followupRun.delegatedTaskId);
        const followupTaskId = followupRun.delegatedTaskId!;

        const grandchildId = NodeId.make("node:followup-grandchild-grandchild");
        const grandchild = {
          id: grandchildId,
          threadId: child.childThreadId,
          runId: followupRun.id,
          parentNodeId: NodeId.make("node:followup-grandchild-child-root"),
          origin: "app_owned" as const,
          createdBy: "agent" as const,
          driver,
          providerInstanceId: modelSelection.instanceId,
          providerThreadId: null,
          childThreadId: ThreadId.make("thread:followup-grandchild-grandchild"),
          nativeTaskRef: null,
          prompt: "Do the next step.",
          title: null,
          model: null,
          completionWake: "always" as const,
          status: "running" as const,
          result: null,
          startedAt: now,
          completedAt: null,
          updatedAt: now,
        };
        yield* eventSink.write({
          commandId: reconcileCommandId("followup-grandchild-turn-ended"),
          events: [
            {
              id: EventId.make("event:followup-grandchild-started"),
              type: "subagent.updated",
              threadId: child.childThreadId,
              runId: followupRun.id,
              nodeId: grandchildId,
              driver,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: grandchild,
            },
            {
              id: EventId.make("event:followup-grandchild-run-completed"),
              type: "run.updated",
              threadId: child.childThreadId,
              runId: followupRun.id,
              occurredAt: now,
              payload: { ...followupRun, status: "completed", startedAt: now, completedAt: now },
            },
          ],
        });
        yield* orchestrator.recoverDelegatedTasks;

        const waiting = yield* orchestrator.getThreadProjection(parentThreadId);
        const heldFollowup = waiting.subagents.find((task) => task.id === followupTaskId);
        assert.isNull(
          heldFollowup?.result ?? null,
          "the follow-up closed while the child's own subagent was still running",
        );
        assert.equal(heldFollowup?.status, "running");
        assert.equal(
          waiting.contextTransfers.filter(
            (transfer) =>
              transfer.type === "subagent_result" &&
              transfer.sourceThreadId === child.childThreadId,
          ).length,
          1,
        );

        // Another turn in the child does not release the hold while the grandchild runs.
        for (const status of ["running", "completed"] as const) {
          yield* eventSink.write({
            commandId: reconcileCommandId(`followup-grandchild-user-${status}`),
            events: [
              runEvent({
                threadId: child.childThreadId,
                runId: RunId.make("run:followup-grandchild-user"),
                ordinal: followupRun.ordinal + 1,
                status,
                now,
              }),
            ],
          });
          yield* orchestrator.recoverDelegatedTasks;
          assert.isNull(
            (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
              (task) => task.id === followupTaskId,
            )?.result ?? null,
            `the follow-up closed while another child run was ${status}`,
          );
        }

        // The grandchild's completion wakes the child in a run without a delegatedTaskId.
        const wakeRunId = RunId.make("run:followup-grandchild-wake");
        const wakeRun = (status: "running" | "completed") =>
          runEvent({
            threadId: child.childThreadId,
            runId: wakeRunId,
            ordinal: followupRun.ordinal + 2,
            status,
            now,
          });
        yield* eventSink.write({
          commandId: reconcileCommandId("followup-grandchild-settled"),
          events: [
            {
              id: EventId.make("event:followup-grandchild-completed"),
              type: "subagent.updated",
              threadId: child.childThreadId,
              runId: followupRun.id,
              nodeId: grandchildId,
              driver,
              providerInstanceId: modelSelection.instanceId,
              occurredAt: now,
              payload: {
                ...grandchild,
                status: "completed",
                result: "grandchild finished",
                completionDelivery: { state: "acknowledged", observedByRunId: wakeRunId },
                completedAt: now,
              },
            },
            {
              id: EventId.make("event:followup-grandchild-wake-message"),
              type: "message.updated",
              threadId: child.childThreadId,
              runId: wakeRunId,
              occurredAt: now,
              payload: {
                id: MessageId.make(`message:${wakeRunId}`),
                threadId: child.childThreadId,
                runId: wakeRunId,
                nodeId: null,
                role: "user",
                text: "Delegated task finished.",
                attachments: [],
                streaming: false,
                createdBy: "agent",
                creationSource: "server",
                delegatedCompletion: {
                  parentRunId: followupRun.id,
                  generation: 1,
                  taskIds: [grandchildId],
                },
                createdAt: now,
                updatedAt: now,
              },
            },
            wakeRun("running"),
          ],
        });
        yield* orchestrator.recoverDelegatedTasks;
        const waking = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
          (task) => task.id === followupTaskId,
        );
        assert.isNull(waking?.result ?? null, "the follow-up closed before the child's wake ended");

        yield* eventSink.write({
          commandId: reconcileCommandId("followup-grandchild-wake-finished"),
          events: [
            {
              id: EventId.make("event:followup-grandchild-wake-result"),
              type: "message.updated",
              threadId: child.childThreadId,
              runId: wakeRunId,
              occurredAt: now,
              payload: {
                id: MessageId.make("message:followup-grandchild-wake-result"),
                threadId: child.childThreadId,
                runId: wakeRunId,
                nodeId: null,
                role: "assistant",
                text: "The grandchild finished the next step.",
                attachments: [],
                streaming: false,
                createdBy: "agent",
                creationSource: "server",
                createdAt: now,
                updatedAt: now,
              },
            },
            wakeRun("completed"),
          ],
        });
        yield* orchestrator.recoverDelegatedTasks;
        const settled = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
          (task) => task.id === followupTaskId,
        );
        assert.equal(settled?.status, "completed");
        assert.equal(settled?.result, "The grandchild finished the next step.");
      }),
    );
  },
);
