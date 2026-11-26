import { assert, it } from "@effect/vitest";
import { CommandId, EventId, MessageId, NodeId, ProjectId, RunId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  layerTest,
  modelSelection,
  seedParentWithTerminalTask,
} from "./DelegatedCompletionDelivery.testkit.ts";

it.layer(layerTest)("delegated workspace retries", (it) => {
  it.effect.each([
    { parentStatus: "running", outcome: "completed" },
    { parentStatus: "running", outcome: "failed" },
    { parentStatus: "stopped", outcome: "completed" },
  ] as const)(
    "delivers each result of a retried workspace preparation once for a $parentStatus parent and a $outcome worker",
    ({ parentStatus, outcome }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const key = `delegated-preparation-retry:${parentStatus}:${outcome}`;
        const threadId = ThreadId.make(`thread:${key}`);
        const parentRunId = RunId.make(`run:${key}`);
        const parentNodeId = NodeId.make(`node:${key}`);
        yield* seedParentWithTerminalTask({
          threadId,
          runId: parentRunId,
          rootNodeId: parentNodeId,
          projectId: ProjectId.make(`project:${key}`),
          taskId: NodeId.make(`node:${key}-sibling`),
          deliveryState: "acknowledged",
          now,
        });
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:${key}:root`),
              type: "node.updated",
              threadId,
              runId: parentRunId,
              nodeId: parentNodeId,
              occurredAt: now,
              payload: {
                id: parentNodeId,
                threadId,
                runId: parentRunId,
                parentNodeId: null,
                rootNodeId: parentNodeId,
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
          commandId: CommandId.make(`command:${key}:delegate`),
          parentThreadId: threadId,
          parentRunId,
          parentNodeId,
          task: "Run the tests in a worktree.",
          modelSelection,
          workspaceStrategy: { type: "worktree", baseRef: "main" },
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          createdBy: "agent",
          creationSource: "mcp",
        });
        const task = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
          (item) => item.childThreadId !== null,
        )!;
        const childThreadId = task.childThreadId!;
        const runId = (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]!.id;
        const readResult = Effect.gen(function* () {
          const parent = yield* orchestrator.getThreadProjection(threadId);
          return {
            task: parent.subagents.find((row) => row.id === task.id)!,
            transfers: parent.contextTransfers.filter(
              (row) => row.type === "subagent_result" && row.sourceThreadId === childThreadId,
            ),
          };
        });
        for (const [attempt, message] of [
          [1, "Workspace missing."],
          [2, "Worktree path occupied."],
        ] as const) {
          yield* orchestrator.dispatch({
            type: "prepared-run.fail",
            commandId: CommandId.make(`command:${key}:fail:${attempt}`),
            threadId: childThreadId,
            runId,
            failure: { class: "validation_error", message, code: null, retryable: false },
          });
          yield* orchestrator.recoverDelegatedTask(childThreadId, { sourceRunId: runId });
          const failed = yield* readResult;
          assert.equal(failed.task.result, message);
          assert.equal(failed.transfers.length, attempt);
          const delivery =
            attempt === 1
              ? (yield* orchestrator.getThreadProjection(threadId)).runs.find(
                  (run) => run.id === parentRunId,
                )?.delegatedCompletion?.delivery
              : undefined;
          assert.isTrue(attempt !== 1 || delivery != null);
          if (delivery != null) {
            assert.equal(failed.task.completionDelivery?.state, "claimed");
            yield* orchestrator.dispatch({
              type: "message.dispatch",
              commandId: CommandId.make(`command:${key}:first-wake`),
              threadId,
              messageId: delivery.messageId,
              text: message,
              attachments: [],
              dispatchMode: { type: "queue_after_active" },
              createdBy: "agent",
              creationSource: "server",
              delegatedCompletion: {
                parentRunId,
                generation: delivery.generation,
                taskIds: delivery.taskIds,
              },
            });
            const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
            assert.equal(
              runs.find((run) => run.userMessageId === delivery.messageId)?.status,
              "queued",
            );
          } else if (parentStatus === "stopped") {
            yield* orchestrator.dispatch({
              type: "thread.stop",
              commandId: CommandId.make(`command:${key}:stop`),
              threadId,
            });
            assert.equal((yield* readResult).task.completionDelivery?.state, "disposed");
          } else {
            yield* orchestrator.dispatch({
              type: "delegated_task.completion-delivery.acknowledge",
              commandId: CommandId.make(`command:${key}:ack`),
              parentThreadId: threadId,
              taskId: task.id,
              observedByRunId: parentRunId,
            });
          }
          yield* orchestrator.dispatch({
            type: "prepared-run.retry",
            commandId: CommandId.make(`command:${key}:retry:${attempt}`),
            threadId: childThreadId,
            runId,
          });
          const reopened = yield* readResult;
          assert.equal(reopened.task.status, "running");
          assert.isNull(reopened.task.result);
          assert.equal(
            reopened.task.completionDelivery?.state,
            attempt === 2 && parentStatus === "stopped" ? "disposed" : "pending",
          );
          if (delivery != null) {
            const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
            const wake = runs.find((run) => run.userMessageId === delivery.messageId);
            assert.equal(wake?.status, "cancelled");
            assert.equal(wake?.terminationCause?.kind, "delegated_wake_disposed");
          }
        }
        yield* orchestrator.dispatch({
          type: "prepared-run.release",
          commandId: CommandId.make(`command:${key}:release`),
          threadId: childThreadId,
          runId,
        });
        const childRun = (yield* orchestrator.getThreadProjection(childThreadId)).runs[0]!;
        assert.equal(childRun.id, runId);
        yield* sink.write({
          events: [
            {
              id: EventId.make(`event:${key}:report`),
              type: "message.updated",
              threadId: childThreadId,
              runId,
              occurredAt: now,
              payload: {
                id: MessageId.make(`message:${key}:report`),
                threadId: childThreadId,
                runId,
                nodeId: childRun.rootNodeId,
                role: "assistant",
                createdBy: "agent",
                creationSource: "provider",
                text: outcome === "completed" ? "The tests passed." : "The test runner stopped.",
                attachments: [],
                streaming: false,
                createdAt: now,
                updatedAt: now,
              },
            },
            {
              id: EventId.make(`event:${key}:complete`),
              type: "run.updated",
              threadId: childThreadId,
              runId,
              occurredAt: now,
              payload: { ...childRun, status: outcome, startedAt: now, completedAt: now },
            },
          ],
        });
        yield* orchestrator.recoverDelegatedTasks;
        const completed = yield* readResult;
        assert.equal(completed.task.status, outcome);
        assert.equal(
          completed.task.result,
          outcome === "completed" ? "The tests passed." : "The test runner stopped.",
        );
        assert.equal(completed.transfers.length, 3);
        assert.equal(
          completed.task.completionDelivery?.state,
          parentStatus === "stopped" ? "disposed" : "claimed",
        );
        yield* orchestrator.recoverDelegatedTask(childThreadId, { sourceRunId: runId });
        assert.deepEqual(yield* readResult, completed);
      }),
  );
});
