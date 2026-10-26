import { assert, it } from "@effect/vitest";
import { CommandId, NodeId, ProjectId, RunId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Orchestrator from "./Orchestrator.ts";
import { layerTest, seedParentWithTerminalTask } from "./DelegatedCompletionDelivery.testkit.ts";

it.layer(layerTest)("delegated completion termination cause", (it) => {
  it.effect("records disposed wake rather than person Stop", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make("thread:disposed-wake-cause");
      const runId = RunId.make("run:disposed-wake-cause");
      const taskId = NodeId.make("node:disposed-wake-cause-task");
      yield* seedParentWithTerminalTask({
        threadId,
        projectId: ProjectId.make("project:disposed-wake-cause"),
        runId,
        rootNodeId: NodeId.make("node:disposed-wake-cause-root"),
        taskId,
        deliveryState: "claimed",
        deliveryTaskIds: [taskId],
        completionWake: "always",
        now,
      });
      const delivery = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!
        .delegatedCompletion!.delivery!;
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("command:disposed-wake-cause"),
        threadId,
        messageId: delivery.messageId,
        text: "Delegated task completed",
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
        delegatedCompletion: {
          parentRunId: runId,
          generation: delivery.generation,
          taskIds: delivery.taskIds,
        },
      });
      const queued = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.userMessageId === delivery.messageId,
      );
      assert.equal(queued?.status, "queued");
      yield* orchestrator.dispatch({
        type: "delegated_task.completion-delivery.dispose",
        commandId: CommandId.make("command:disposed-wake-cause:dispose"),
        parentThreadId: threadId,
        taskId,
      });
      const cancelled = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.id === queued?.id,
      );
      assert.equal(cancelled?.status, "cancelled");
      assert.equal(cancelled?.terminationCause?.kind, "delegated_wake_disposed");
    }),
  );
});
