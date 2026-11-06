import { assert, it } from "@effect/vitest";
import { EventId, NodeId, ProjectId, RunId, ThreadId, TurnItemId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ProviderContinuationRequests from "@goat/provider-core/server/ProviderContinuationRequests";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import {
  layerTest,
  reconcileCommandId,
  seedParentWithTerminalTask,
  seedRestartCancelledChild,
} from "./DelegatedCompletionDelivery.testkit.ts";

it.layer(Layer.merge(layerTest, ProviderContinuationRequests.layer))(
  "usage-limit followups",
  (it) => {
    it.effect("tracks a child's usage-limit auto-resume as a follow-up", () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const eventSink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        const parentThreadId = ThreadId.make("thread:limit-resume-parent");
        const projectId = ProjectId.make("project:limit-resume");
        const parentRunId = RunId.make("run:limit-resume-parent");
        const rootNodeId = NodeId.make("node:limit-resume-parent");
        yield* seedParentWithTerminalTask({
          threadId: parentThreadId,
          projectId,
          runId: parentRunId,
          rootNodeId,
          taskId: NodeId.make("node:limit-resume-seed"),
          deliveryState: "acknowledged",
          now,
        });
        const child = yield* seedRestartCancelledChild({
          parentThreadId,
          projectId,
          parentRunId,
          rootNodeId,
          name: "limit-resume-child",
          completionWake: "always",
          continuationPending: false,
          runStatus: "completed",
          now,
        });
        const childRun = (yield* orchestrator.getThreadProjection(child.childThreadId)).runs[0]!;
        yield* eventSink.write({
          commandId: reconcileCommandId("limit-resume-child-limited"),
          events: [
            {
              id: EventId.make("event:limit-resume-child-failed"),
              type: "run.updated",
              threadId: child.childThreadId,
              runId: childRun.id,
              occurredAt: now,
              payload: { ...childRun, status: "failed", completedAt: now },
            },
            {
              id: EventId.make("event:limit-resume-child-error"),
              type: "turn-item.updated",
              threadId: child.childThreadId,
              occurredAt: now,
              payload: {
                id: TurnItemId.make("turn-item:limit-resume-child-error"),
                type: "error",
                threadId: child.childThreadId,
                runId: childRun.id,
                nodeId: childRun.rootNodeId,
                providerThreadId: null,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 1,
                status: "failed",
                title: "Usage limit reached",
                startedAt: now,
                completedAt: now,
                updatedAt: now,
                failure: {
                  class: "usage_limit",
                  message: "Plan limit reached.",
                  code: "usageLimitExceeded",
                  retryable: null,
                  resetAt: DateTime.formatIso(DateTime.add(now, { minutes: 1 })),
                },
              },
            },
          ],
        });
        yield* orchestrator.recoverDelegatedTasks;
        const childShell = Effect.map(orchestrator.getShellSnapshot(), (snapshot) =>
          snapshot.threads.find((thread) => thread.id === child.childThreadId),
        );
        const arm = limitRecoveryCommand((yield* childShell)!, true, DateTime.toEpochMillis(now));
        assert(arm?.type === "thread.metadata.update" && arm.limitRecovery != null);
        yield* orchestrator.autoArmLimitRecovery({
          commandId: arm.commandId,
          threadId: arm.threadId,
          limitRecovery: arm.limitRecovery,
        });
        yield* TestClock.adjust("1 minute");
        const resume = limitRecoveryCommand(
          (yield* childShell)!,
          true,
          DateTime.toEpochMillis(yield* DateTime.now),
        );
        assert(resume?.type === "message.dispatch");
        assert.equal(resume.createdBy, "agent");
        assert.equal(resume.creationSource, "server");
        yield* orchestrator.dispatch(resume);

        const resumed = (yield* orchestrator.getThreadProjection(child.childThreadId)).runs.find(
          (run) => run.userMessageId === resume.messageId,
        );
        assert.isDefined(resumed?.delegatedTaskId);
        const followup = (yield* orchestrator.getThreadProjection(parentThreadId)).subagents.find(
          (task) => task.id === resumed?.delegatedTaskId,
        );
        assert.equal(followup?.childThreadId, child.childThreadId);
        assert.isNull(followup?.result);
      }),
    );
  },
);
