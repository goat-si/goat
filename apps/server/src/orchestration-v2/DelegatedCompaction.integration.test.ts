import { assert, it } from "@effect/vitest";
import { CommandId, MessageId, NodeId, ProjectId, RunId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import * as Orchestrator from "./Orchestrator.ts";
import { seedRestartCancelledChild } from "./DelegatedCompletionDelivery.testkit.ts";
import { layerTest, seedParentWithTerminalTask } from "./DelegatedCompletionDelivery.testkit.ts";

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))(
  "subagent compaction",
  (it) => {
    it.effect("tracks a user's follow-up but not the compaction sent ahead of it", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const now = yield* DateTime.now;
        const parentThreadId = ThreadId.make("thread:followup-compact-parent");
        const projectId = ProjectId.make("project:followup-compact");
        const parentRunId = RunId.make("run:followup-compact-parent");
        const rootNodeId = NodeId.make("node:followup-compact-parent");
        yield* seedParentWithTerminalTask({
          threadId: parentThreadId,
          projectId,
          runId: parentRunId,
          rootNodeId,
          taskId: NodeId.make("node:followup-compact-seed"),
          deliveryState: "acknowledged",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId,
          projectId,
          parentRunId,
          rootNodeId,
          name: "followup-compact-child",
          completionWake: "always",
          continuationPending: false,
          runStatus: "completed",
          now,
        });
        yield* orchestrator.recoverDelegatedTasks;
        const tasksBefore = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents
          .length;

        const send = (name: string, text: string) =>
          orchestrator.dispatch({
            type: "message.dispatch",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make(`command:followup-compact-${name}`),
            threadId: child.childThreadId,
            messageId: MessageId.make(`message:followup-compact-${name}`),
            text,
            attachments: [],
            dispatchMode: { type: "queue_after_active" },
          });
        yield* send("compact", "/compact");
        yield* send("ask", "Write the next packet.");

        const runs = (yield* orchestrator.getThreadProjection(child.childThreadId)).runs;
        const runOf = (name: string) =>
          runs.find((run) => run.userMessageId === `message:followup-compact-${name}`);
        assert.isDefined(runOf("compact"));
        assert.isUndefined(runOf("compact")?.delegatedTaskId);
        assert.isDefined(runOf("ask")?.delegatedTaskId);
        assert.equal(
          (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.length,
          tasksBefore + 1,
        );
      }),
    );
  },
);
