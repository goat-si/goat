import { derive } from "@goat/provider-core/server/IdAllocator";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  NodeId,
  ProjectId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  modelSelection,
  driver,
  layerTest,
  seedParentWithTerminalTask,
} from "./DelegatedCompletionDelivery.testkit.ts";

it.layer(layerTest)("remote delegated attachments", (it) => {
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
      const attachments = [
        {
          messageId: MessageId.make("evidence-message"),
          attachmentId: "evidence",
          attemptId: RunAttemptId.make("attempt"),
          name: "evidence.xml",
        },
      ];
      yield* orchestrator.dispatch({
        type: "delegated_task.remote.result",
        commandId: CommandId.make("result-A"),
        parentThreadId: threadId,
        taskId,
        correlationId: "rr-A",
        status: "completed",
        summary: "A done",
        attachments,
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
      assert.deepEqual(task.resultAttachments, attachments);
      assert.equal(after.contextTransfers.length, before.contextTransfers.length);
    }),
  );
});
