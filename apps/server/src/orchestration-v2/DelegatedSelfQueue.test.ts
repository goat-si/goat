import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  RunId,
  ThreadId,
  type OrchestrationV2Run,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Orchestrator from "./Orchestrator.ts";
import * as EventSink from "./EventSink.ts";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import {
  layerTest,
  seedParentWithTerminalTask,
  seedRestartCancelledChild,
  reconcileCommandId,
} from "./DelegatedCompletionDelivery.testkit.ts";

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))(
  "self-queued delegated continuation",
  (it) => {
    // The child's follow-up run sends `goat_thread_send` to its own thread before it ends.
    const startSelfQueuedFollowup = (name: string) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const now = yield* DateTime.now;
        const parentThreadId = ThreadId.make(`thread:${name}-parent`);
        const projectId = ProjectId.make(`project:${name}`);
        const parentRunId = RunId.make(`run:${name}-parent`);
        const rootNodeId = NodeId.make(`node:${name}-parent`);
        yield* seedParentWithTerminalTask({
          threadId: parentThreadId,
          projectId,
          runId: parentRunId,
          rootNodeId,
          taskId: NodeId.make(`node:${name}-seed`),
          deliveryState: "acknowledged",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId,
          projectId,
          parentRunId,
          rootNodeId,
          name: `${name}-child`,
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
          commandId: CommandId.make(`command:${name}-ack`),
          parentThreadId,
          taskId: child.taskId,
          observedByRunId: parentRunId,
        });
        const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.find(
          (run) => run.id === parentRunId,
        )!;
        yield* eventSink.write({
          commandId: reconcileCommandId(`${name}-parent-finished`),
          events: [
            {
              id: EventId.make(`event:${name}-parent-finished`),
              type: "run.updated",
              threadId: parentThreadId,
              runId: parentRunId,
              occurredAt: now,
              payload: { ...parentRun, status: "completed", completedAt: now },
            },
          ],
        });
        const followupMessageId = MessageId.make(`message:${name}`);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: CommandId.make(`command:${name}`),
          threadId: child.childThreadId,
          senderThreadId: parentThreadId,
          messageId: followupMessageId,
          text: "Check the same work again.",
          attachments: [],
          dispatchMode: { type: "start_immediately" },
        });
        const queuedRun = (yield* orchestrator.getThreadProjection(child.childThreadId)).runs.find(
          (row) => row.userMessageId === followupMessageId,
        )!;
        const followupTaskId = queuedRun.delegatedTaskId;
        assert.isDefined(followupTaskId);
        const followupRun = { ...queuedRun, status: "running" as const, startedAt: now };
        yield* eventSink.write({
          commandId: reconcileCommandId(`${name}-running`),
          events: [
            {
              id: EventId.make(`event:${name}-running`),
              type: "run.updated",
              threadId: child.childThreadId,
              runId: followupRun.id,
              occurredAt: now,
              payload: followupRun,
            },
          ],
        });
        const selfQueuedMessageId = MessageId.make(`message:${name}-self-send`);
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: CommandId.make(`command:${name}-self-send`),
          threadId: child.childThreadId,
          senderThreadId: child.childThreadId,
          messageId: selfQueuedMessageId,
          text: "Finish the work after this turn.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
        });
        const selfQueuedRun = (yield* orchestrator.getThreadProjection(
          child.childThreadId,
        )).runs.find((row) => row.userMessageId === selfQueuedMessageId)!;
        assert.equal(selfQueuedRun.status, "queued");
        const finishRun = (step: string, run: OrchestrationV2Run, text: string) =>
          eventSink.write({
            commandId: reconcileCommandId(`${name}-${step}`),
            events: [
              {
                id: EventId.make(`event:${name}-${step}:result`),
                type: "message.updated",
                threadId: child.childThreadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  id: MessageId.make(`message:${name}-${step}:result`),
                  threadId: child.childThreadId,
                  runId: run.id,
                  nodeId: null,
                  role: "assistant",
                  text,
                  attachments: [],
                  streaming: false,
                  createdBy: "agent",
                  creationSource: "server",
                  createdAt: now,
                  updatedAt: now,
                },
              },
              {
                id: EventId.make(`event:${name}-${step}:finished`),
                type: "run.updated",
                threadId: child.childThreadId,
                runId: run.id,
                occurredAt: now,
                payload: { ...run, status: "completed", startedAt: now, completedAt: now },
              },
            ],
          });
        const removeSelfQueuedRun = orchestrator.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make(`command:${name}-remove-self-send`),
          threadId: child.childThreadId,
          runId: selfQueuedRun.id,
        });
        const readFollowup = Effect.gen(function* () {
          yield* orchestrator.recoverDelegatedTasks;
          return (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
            (task) => task.id === followupTaskId,
          )!;
        });
        return {
          parentThreadId,
          parentRunId,
          childThreadId: child.childThreadId,
          firstWake,
          followupRun,
          selfQueuedRun,
          finishRun,
          removeSelfQueuedRun,
          readFollowup,
        };
      });

    it.effect("waits for a run the follow-up's child queued on its own thread", () =>
      Effect.gen(function* () {
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const followup = yield* startSelfQueuedFollowup("self-queued-followup");
        yield* followup.finishRun("handoff", followup.followupRun, "HANDOFF-C");
        const waiting = yield* followup.readFollowup;
        assert.isNull(
          waiting.result,
          "the follow-up task settled on its handoff turn while the run its child queued was pending",
        );
        assert.notEqual(waiting.status, "completed");

        yield* followup.finishRun("final", followup.selfQueuedRun, "FINAL-D");
        const finished = yield* followup.readFollowup;
        assert.equal(finished.status, "completed");
        assert.equal(finished.result, "FINAL-D");
        assert.equal(finished.completionDelivery?.state, "claimed");
        let wake = yield* requests.take;
        while (
          wake.threadId !== followup.parentThreadId ||
          wake.delegatedCompletion?.messageId === followup.firstWake.delegatedCompletion?.messageId
        ) {
          wake = yield* requests.take;
        }
        assert.equal(wake.delegatedCompletion?.parentRunId, followup.parentRunId);
      }),
    );

    it.effect("keeps a follow-up running when the run its child queued is removed early", () =>
      Effect.gen(function* () {
        const followup = yield* startSelfQueuedFollowup("self-queued-removed-early-followup");
        yield* followup.removeSelfQueuedRun;
        const running = yield* followup.readFollowup;
        assert.isNull(running.result);
        assert.equal(running.status, "running");

        yield* followup.finishRun("handoff", followup.followupRun, "HANDOFF-C");
        const finished = yield* followup.readFollowup;
        assert.equal(finished.status, "completed");
        assert.equal(finished.result, "HANDOFF-C");
      }),
    );

    it.effect.each(["removed", "held"] as const)(
      "settles a follow-up on its last turn when the run it queued is %s",
      (ending) =>
        Effect.gen(function* () {
          const eventSink = yield* EventSink.EventSinkV2;
          const now = yield* DateTime.now;
          const followup = yield* startSelfQueuedFollowup(`self-queued-${ending}-followup`);
          if (ending === "held") {
            yield* eventSink.write({
              commandId: reconcileCommandId("self-queued-held-followup-hold"),
              events: [
                {
                  id: EventId.make("event:self-queued-held-followup-hold"),
                  type: "run.updated",
                  threadId: followup.childThreadId,
                  runId: followup.selfQueuedRun.id,
                  occurredAt: now,
                  payload: { ...followup.selfQueuedRun, queueHeld: true },
                },
              ],
            });
          }
          yield* followup.finishRun("handoff", followup.followupRun, "HANDOFF-C");
          if (ending === "removed") yield* followup.removeSelfQueuedRun;
          const finished = yield* followup.readFollowup;
          assert.equal(finished.status, "completed");
          assert.equal(finished.result, "HANDOFF-C");
        }),
    );

    it.effect("waits for every run its child queued when a later one is moved ahead", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const followup = yield* startSelfQueuedFollowup("self-queued-reordered-followup");
        const laterMessageId = MessageId.make("message:self-queued-reordered-followup-later");
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "mcp",
          commandId: CommandId.make("command:self-queued-reordered-followup-later"),
          threadId: followup.childThreadId,
          senderThreadId: followup.childThreadId,
          messageId: laterMessageId,
          text: "Do this part first.",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
        });
        const later = (yield* orchestrator.getThreadProjection(followup.childThreadId)).runs.find(
          (run) => run.userMessageId === laterMessageId,
        )!;
        yield* orchestrator.dispatch({
          type: "queued-run.reorder",
          commandId: CommandId.make("command:self-queued-reordered-followup-reorder"),
          threadId: followup.childThreadId,
          runId: later.id,
          beforeRunId: followup.selfQueuedRun.id,
        });
        assert.equal((yield* followup.readFollowup).status, "running");
        yield* followup.finishRun("handoff", followup.followupRun, "HANDOFF-C");
        yield* followup.finishRun("later", later, "PART-ONE");
        const waiting = yield* followup.readFollowup;
        assert.isNull(waiting.result, "the follow-up settled while an earlier queued run waited");

        // Promotion moves a queued run after the runs that started ahead of it.
        const promoted = { ...followup.selfQueuedRun, ordinal: later.ordinal + 1 };
        yield* followup.finishRun("final", promoted, "FINAL-D");
        const finished = yield* followup.readFollowup;
        assert.equal(finished.status, "completed");
        assert.equal(finished.result, "FINAL-D");
      }),
    );
  },
);
