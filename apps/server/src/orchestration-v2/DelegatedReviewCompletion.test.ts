import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  ProviderThreadId,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import { derive } from "@goat/provider-core/server/IdAllocator";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  driver,
  layerTest,
  modelSelection,
  reconcileCommandId,
  runEvent,
  seedParentWithTerminalTask,
  seedRestartCancelledChild,
} from "./DelegatedCompletionDelivery.testkit.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { DelegatedTaskCancellation } from "./goat/DelegatedTaskCancellation.ts";

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))(
  "delegated review completion",
  (it) => {
    it.effect.each(["always", "settled_only", "cancelled"] as const)(
      "settles a continued review round with delivery %s",
      (scenario) =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
          const now = yield* DateTime.now;
          const name = "continued-review-" + scenario;
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
            completionWake: scenario === "cancelled" ? "always" : scenario,
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
          if (scenario === "cancelled") {
            const wakeId = RunId.make(`run:${name}:completion-wake`);
            const wakeMessageId = MessageId.make(`message:${name}:completion-wake`);
            const nativeId = NodeId.make(`node:${name}:native-subagent`);
            const wakeRun = runEvent({
              threadId: child.childThreadId,
              runId: wakeId,
              ordinal: run.ordinal + 1,
              status: "completed",
              now,
            });
            yield* eventSink.write({
              events: [
                { ...wakeRun, payload: { ...wakeRun.payload, userMessageId: wakeMessageId } },
                {
                  id: EventId.make(`event:${name}:wake-message`),
                  type: "message.updated",
                  threadId: child.childThreadId,
                  runId: wakeId,
                  occurredAt: now,
                  payload: {
                    id: wakeMessageId,
                    threadId: child.childThreadId,
                    runId: wakeId,
                    nodeId: null,
                    role: "user",
                    text: "A delegated check finished.",
                    attachments: [],
                    streaming: false,
                    createdBy: "agent",
                    creationSource: "server",
                    createdAt: now,
                    updatedAt: now,
                    delegatedCompletion: {
                      parentRunId: run.id,
                      generation: 1,
                      taskIds: [NodeId.make(`node:${name}:delegated-check`)],
                    },
                  },
                },
                {
                  id: EventId.make(`event:${name}:native-subagent`),
                  type: "subagent.updated",
                  threadId: child.childThreadId,
                  runId: wakeId,
                  nodeId: nativeId,
                  occurredAt: now,
                  payload: {
                    ...seeded,
                    id: nativeId,
                    threadId: child.childThreadId,
                    runId: wakeId,
                    origin: "provider_native",
                    childThreadId: null,
                    status: "running",
                    result: null,
                    completedAt: null,
                  },
                },
              ],
            });
            const commandId = CommandId.make(`command:${name}:stop`);
            yield* orchestrator
              .dispatch({
                type: "thread.stop",
                commandId,
                threadId: child.childThreadId,
                stopDelegatedTasks: false,
              })
              .pipe(
                Effect.provideService(DelegatedTaskCancellation, {
                  commandId,
                  parentThreadId,
                  taskId,
                  stopDescendants: Effect.void,
                }),
              );
            yield* orchestrator.recoverDelegatedTasks;
            const parent = yield* orchestrator.getThreadProjection(parentThreadId);
            const round = parent.subagents.find((task) => task.id === taskId);
            assert.equal(round?.status, "interrupted");
            assert.equal(round?.cancelledRunId, wakeId);
            assert.deepEqual(round?.completionDelivery, {
              state: "disposed",
              observedByRunId: null,
            });
            return;
          }
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
  },
);
