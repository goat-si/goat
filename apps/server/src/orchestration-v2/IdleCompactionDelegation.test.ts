import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, NodeId, ProjectId, RunId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Orchestrator from "./Orchestrator.ts";
import { layerTest, seedParentWithTerminalTask } from "./DelegatedCompletionDelivery.testkit.ts";

it.layer(layerTest)("idle compaction with delegated work", (it) => {
  it.effect.each([
    { name: "no result is waiting", delivery: "none", compacts: true },
    { name: "a result is waiting to be sent", delivery: "pending", compacts: false },
    { name: "a result was just sent", delivery: "sent", compacts: false },
  ] as const)("compacts before the cache expires only when $name", ({ delivery, compacts }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const now = yield* DateTime.now;
      const threadId = ThreadId.make(`thread:idle-compaction-delivery-${delivery}`);
      const runId = RunId.make(`run:idle-compaction-delivery-${delivery}`);
      const taskId = NodeId.make(`node:idle-compaction-delivery-${delivery}-task`);

      yield* seedParentWithTerminalTask({
        threadId,
        projectId: ProjectId.make(`project:idle-compaction-delivery-${delivery}`),
        runId,
        rootNodeId: NodeId.make(`node:idle-compaction-delivery-${delivery}-root`),
        taskId,
        deliveryState: delivery === "none" ? "delivered" : "claimed",
        completionWake: "always",
        parentRunStatus: "completed",
        ...(delivery === "none" ? {} : { deliveryTaskIds: [taskId] }),
        now,
      });
      if (delivery === "sent") {
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(`command:idle-compaction-delivery-${delivery}`),
          threadId,
          messageId: MessageId.make(`message:delegated-delivery:${threadId}`),
          text: `Delegated task ${taskId} reached a terminal state.`,
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
          delegatedCompletion: { parentRunId: runId, generation: 1, taskIds: [taskId] },
        });
      }

      const compactionId = MessageId.make(`idle-compact:${threadId}:${runId}`);
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(`server:idle-compact:${threadId}:${runId}`),
        threadId,
        messageId: compactionId,
        text: "/compact",
        attachments: [],
        createdBy: "agent",
        creationSource: "server",
        idleCompaction: "beforeCacheExpires",
        dispatchMode: { type: "start_immediately" },
      });

      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        projection.messages.some((message) => message.id === compactionId),
        compacts,
      );
    }),
  );
});
