import { assert, it } from "@effect/vitest";
import {
  CheckpointId,
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import { vi } from "vite-plus/test";
import * as DateTime from "effect/DateTime";
import * as Stream from "effect/Stream";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import {
  layerTest,
  reconcileCommandId,
  seedParentWithTerminalTask,
  seedRestartCancelledChild,
} from "./DelegatedCompletionDelivery.testkit.ts";

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))(
  "delegated completion checkpoint retries",
  (it) => {
    it.effect("checkpoint retry releases a pending sibling after its wake offer failed", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
        const now = yield* DateTime.now;
        const threadId = ThreadId.make("thread:checkpoint-own-delivery");
        const originRunId = RunId.make("run:checkpoint-own-delivery:origin");
        const firstId = NodeId.make("node:checkpoint-own-delivery:first");
        const siblingId = NodeId.make("node:checkpoint-own-delivery:sibling");
        yield* seedParentWithTerminalTask({
          threadId,
          projectId: ProjectId.make("project:checkpoint-own-delivery"),
          runId: originRunId,
          rootNodeId: NodeId.make("node:checkpoint-own-delivery:root"),
          taskId: firstId,
          deliveryState: "claimed",
          deliveryTaskIds: [firstId],
          parentRunStatus: "completed",
          now,
        });
        const original = yield* orchestrator.getThreadProjection(threadId);
        const first = original.subagents.find((task) => task.id === firstId)!;
        const delivery = original.runs.find((run) => run.id === originRunId)!.delegatedCompletion!
          .delivery!;
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          createdBy: "agent",
          creationSource: "server",
          commandId: reconcileCommandId("checkpoint-own-delivery-wake"),
          threadId,
          messageId: delivery.messageId,
          text: "First result",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          delegatedCompletion: {
            parentRunId: originRunId,
            generation: delivery.generation,
            taskIds: delivery.taskIds,
          },
        });
        const started = yield* orchestrator.getThreadProjection(threadId);
        const run = started.runs.find(
          (candidate) => candidate.userMessageId === delivery.messageId,
        )!;
        const scopeId = started.nodes.find(
          (node) => node.id === run.rootNodeId,
        )!.checkpointScopeId!;
        yield* outbox.cancelUnsettled({
          threadId,
          effectTypes: ["provider-turn.start"],
          reason: "The delivery turn already completed.",
        });
        const commandId = reconcileCommandId("checkpoint-own-delivery-finished");
        yield* sink.writeWithEffects({
          commandId,
          events: [
            {
              id: EventId.make("event:checkpoint-own-delivery:sibling"),
              type: "subagent.updated",
              threadId,
              runId: originRunId,
              nodeId: siblingId,
              occurredAt: now,
              payload: {
                ...first,
                id: siblingId,
                completionDelivery: { state: "pending", observedByRunId: null },
              },
            },
            {
              id: EventId.make("event:checkpoint-own-delivery:finished"),
              type: "run.updated",
              threadId,
              runId: run.id,
              occurredAt: now,
              payload: {
                ...run,
                status: "completed",
                startedAt: now,
                completedAt: now,
                checkpointId: CheckpointId.make("checkpoint:own-delivery"),
              },
            },
          ],
          effects: [
            {
              id: "effect:checkpoint-own-delivery",
              commandId,
              threadId,
              request: { type: "checkpoint.capture", runId: run.id, scopeId },
            },
          ],
        });
        using offer = vi
          .spyOn(requests, "offer")
          .mockImplementationOnce(() => Effect.die("successor wake offer failed"));
        const firstAttempt = yield* Effect.exit(
          orchestrator.recoverDelegatedTask(threadId, { completedRunId: run.id }),
        );
        assert.isTrue(Exit.isFailure(firstAttempt));
        const reserved = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (candidate) => candidate.id === originRunId,
        )!.delegatedCompletion!.delivery!;
        assert.deepEqual(reserved.taskIds, [siblingId]);
        yield* worker.drain();
        assert.lengthOf(offer.mock.calls, 2);
        const completed = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          completed.subagents.find((task) => task.id === firstId)?.completionDelivery?.state,
          "delivered",
        );
        assert.equal(
          completed.subagents.find((task) => task.id === siblingId)?.completionDelivery?.state,
          "claimed",
        );
        assert.deepEqual(
          completed.runs.find((candidate) => candidate.id === originRunId)?.delegatedCompletion
            ?.delivery?.taskIds,
          [siblingId],
        );
        let wake = yield* requests.take;
        while (wake.threadId !== threadId) wake = yield* requests.take;
        assert.equal(wake.delegatedCompletion?.generation, delivery.generation + 1);
      }),
    );

    it.effect.each(["live", "checkpoint-retry", "checkpoint-offer-retry"] as const)(
      "delivers the run a background command's wake starts after the original result (%s)",
      (delivery) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const now = yield* DateTime.now;
          const parentThreadId = ThreadId.make(`thread:background-wake-parent-${delivery}`);
          const projectId = ProjectId.make(`project:background-wake-${delivery}`);
          const parentRunId = RunId.make(`run:background-wake-parent-${delivery}`);
          const rootNodeId = NodeId.make(`node:background-wake-parent-${delivery}`);
          yield* seedParentWithTerminalTask({
            threadId: parentThreadId,
            projectId,
            runId: parentRunId,
            rootNodeId,
            taskId: NodeId.make(`node:background-wake-seed-${delivery}`),
            deliveryState: "acknowledged",
            now,
          });
          const child = yield* seedRestartCancelledChild({
            parentThreadId,
            projectId,
            parentRunId,
            rootNodeId,
            name: `background-wake-child-${delivery}`,
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
            commandId: CommandId.make(`command:background-wake-ack-${delivery}`),
            parentThreadId,
            taskId: child.taskId,
            observedByRunId: parentRunId,
          });
          const parentRun = (yield* orchestrator.getThreadProjection(parentThreadId)).runs.find(
            (run) => run.id === parentRunId,
          )!;
          yield* eventSink.write({
            commandId: reconcileCommandId(`background-wake-parent-finished-${delivery}`),
            events: [
              {
                id: EventId.make(`event:background-wake-parent-finished-${delivery}`),
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
          const wakeMessageId = MessageId.make(`message:background-wake-${delivery}`);
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "agent",
            creationSource: "provider",
            commandId:
              delivery === "live"
                ? CommandId.make(`command:background-wake-${delivery}`)
                : reconcileCommandId(`background-wake-${delivery}`),
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
          const childProjection = yield* orchestrator.getThreadProjection(child.childThreadId);
          const run = childProjection.runs.find((row) => row.userMessageId === wakeMessageId)!;
          const scopeId = childProjection.nodes.find(
            (node) => node.id === run.rootNodeId,
          )!.checkpointScopeId!;
          const commandId =
            delivery === "live"
              ? CommandId.make(`command:background-wake-finished-${delivery}`)
              : reconcileCommandId(`background-wake-finished-${delivery}`);
          if (delivery !== "live") {
            const outbox = yield* EffectOutbox.EffectOutboxV2;
            yield* outbox.cancelUnsettled({
              threadId: child.childThreadId,
              effectTypes: ["provider-turn.start"],
              reason: "The turn already finished before its checkpoint retry.",
            });
          }
          const afterSequence = yield* eventSink.latestSequence();
          assert.isDefined(run.delegatedTaskId);
          yield* eventSink.writeWithEffects({
            commandId,
            effects:
              delivery === "live"
                ? []
                : [
                    {
                      id: `effect:background-wake-checkpoint-retry-${delivery}`,
                      commandId,
                      threadId: child.childThreadId,
                      request: { type: "checkpoint.capture", runId: run.id, scopeId },
                    },
                  ],
            events: [
              {
                id: EventId.make(`event:background-wake-result-${delivery}`),
                type: "message.updated",
                threadId: child.childThreadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  id: MessageId.make(`message:background-wake-result-${delivery}`),
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
                id: EventId.make(`event:background-wake-finished-${delivery}`),
                type: "run.updated",
                threadId: child.childThreadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  ...run,
                  status: "completed",
                  startedAt: now,
                  completedAt: now,
                  checkpointId:
                    delivery === "live"
                      ? null
                      : CheckpointId.make(`checkpoint:background-wake-${delivery}`),
                },
              },
            ],
          });
          if (delivery !== "live") {
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            if (delivery === "checkpoint-offer-retry") {
              using offer = vi
                .spyOn(requests, "offer")
                .mockImplementationOnce(() => Effect.die("wake offer failed"));
              const first = yield* Effect.exit(
                orchestrator.recoverDelegatedTask(child.childThreadId),
              );
              assert.isTrue(Exit.isFailure(first));
              const committed = (yield* orchestrator.getThreadProjection(
                parentThreadId,
              )).subagents.find((task) => task.id === run.delegatedTaskId)!;
              assert.equal(committed.result, "The background command finished cleanly.");
              yield* worker.drain();
              assert.lengthOf(offer.mock.calls, 2);
            } else {
              yield* worker.drain();
            }
          } else {
            yield* eventSink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "subagent.updated" &&
                  stored.event.payload.id === run.delegatedTaskId &&
                  stored.event.payload.status === "completed",
              ),
              Stream.take(1),
              Stream.runDrain,
            );
          }
          const completed = yield* orchestrator.getThreadProjection(parentThreadId);
          const followup = completed.subagents.find((task) => task.id === run.delegatedTaskId)!;
          assert.lengthOf(
            completed.contextTransfers.filter(
              (transfer) =>
                transfer.type === "subagent_result" &&
                transfer.sourceThreadId === child.childThreadId,
            ),
            2,
          );
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
  },
);
