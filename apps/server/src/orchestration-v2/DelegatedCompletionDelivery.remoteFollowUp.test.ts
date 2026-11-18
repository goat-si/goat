import { derive } from "@goat/provider-core/server/IdAllocator";
import { assert, it } from "@effect/vitest";
import { CommandId, EventId, NodeId, ProjectId, RunId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import {
  driver,
  layerTest,
  modelSelection,
  seedParentWithTerminalTask,
} from "./DelegatedCompletionDelivery.testkit.ts";

it.layer(layerTest)("remote task follow-ups", (it) => {
  it.effect("a follow-up to a finished remote task registers after the parent's run ended", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("remote-follow-up-parent");
      const runId = RunId.make("remote-follow-up-run");
      const root = NodeId.make("remote-follow-up-root");
      yield* seedParentWithTerminalTask({
        threadId,
        runId,
        rootNodeId: root,
        projectId: ProjectId.make("remote-follow-up-project"),
        taskId: NodeId.make("remote-follow-up-original"),
        deliveryState: "acknowledged",
        completionWake: "always",
        remote: true,
        parentRunStatus: "completed",
        now,
      });
      yield* sink.write({
        events: [
          {
            id: EventId.make("remote-follow-up-root-event"),
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
              status: "completed",
              countsForRun: true,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              runtimeRequestId: null,
              checkpointScopeId: null,
              startedAt: now,
              completedAt: now,
            },
          },
        ],
      });
      const commandId = CommandId.make("register-remote-follow-up");
      const taskId = derive.delegatedTaskNode({ commandId });
      const register = (remoteThreadId: string) =>
        orchestrator.dispatch({
          type: "delegated_task.remote.register",
          commandId: CommandId.make(`${commandId}:${remoteThreadId}`),
          parentThreadId: threadId,
          parentRunId: runId,
          parentNodeId: root,
          createdBy: "agent",
          creationSource: "mcp",
          task: "Now run the slow suite too.",
          modelSelection,
          driver,
          runtimeMode: "full-access",
          interactionMode: "default",
          completionWake: "always",
          remote: { host: "box", threadId: ThreadId.make(remoteThreadId), correlationId: "rr-f" },
        });
      // Only a send to a thread whose task already has its result binds to an ended run.
      const unrelated = yield* Effect.flip(register("another-remote-child"));
      assert.include(String(unrelated.cause), "Remote task parent run is not active.");
      yield* orchestrator.dispatch({
        type: "delegated_task.remote.register",
        commandId,
        parentThreadId: threadId,
        parentRunId: runId,
        parentNodeId: root,
        createdBy: "agent",
        creationSource: "mcp",
        task: "Now run the slow suite too.",
        modelSelection,
        driver,
        runtimeMode: "full-access",
        interactionMode: "default",
        completionWake: "always",
        remote: { host: "box", threadId: ThreadId.make("remote-child"), correlationId: "rr-f" },
      });
      const registered = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
        (task) => task.id === taskId,
      );
      assert.equal(registered?.runId, runId);
      assert.equal(registered?.status, "running");
      yield* orchestrator.dispatch({
        type: "delegated_task.remote.result",
        commandId: CommandId.make("remote-follow-up-result"),
        parentThreadId: threadId,
        taskId,
        correlationId: "rr-f",
        status: "completed",
        summary: "The slow suite passes too.",
      });
      // Its result claims a wake of the parent like any finished task's.
      const after = yield* orchestrator.getThreadProjection(threadId);
      const followUp = after.subagents.find((task) => task.id === taskId);
      assert.equal(followUp?.result, "The slow suite passes too.");
      assert.equal(followUp?.completionDelivery?.state, "claimed");
      const delivery = after.runs.find((run) => run.id === runId)?.delegatedCompletion?.delivery;
      assert.deepEqual(delivery?.taskIds, [taskId]);
    }),
  );
});
