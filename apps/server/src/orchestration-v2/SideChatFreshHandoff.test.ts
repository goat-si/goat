import { it } from "@effect/vitest";
import {
  ContextHandoffId,
  ContextTransferId,
  ScheduledTaskId,
  ThreadId,
  TurnItemId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";
import { selectSideChatHandoffs } from "./SideChatHandoffSelection.ts";

it.effect.each([false, true])(
  "fresh side-chat turns retire old handoffs only when unscheduled: %s",
  (scheduled) =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Start over",
        sideChatParentMissing: true,
        manualResume: { accepted: false, supported: false },
        previousTurn: { runStatus: "failed", turnStatus: "interrupted" },
      });
      const projection = harness.projection();
      const previous = projection.runs[0]!;
      const current = projection.runs.find((run) => run.id === harness.runId)!;
      const { manualContinuationOfRunId: _manual, ...freshRun } = current;
      const handoff = {
        id: ContextHandoffId.make("side-chat-old-handoff"),
        transferId: ContextTransferId.make("side-chat-old-transfer"),
        threadId: harness.threadId,
        targetRunId: previous.id,
        fromProviderThreadIds: [],
        toProviderThreadId: current.providerThreadId!,
        coveredRunOrdinals: { from: 1, to: 1 },
        strategy: "manual_context" as const,
        status: "ready" as const,
        summaryMessageId: null,
        summaryText: "Parent digest",
        createdByProviderInstanceId: current.providerInstanceId,
        createdAt: projection.updatedAt,
        updatedAt: projection.updatedAt,
      };
      harness.setProjection({
        ...projection,
        thread: { ...projection.thread, sideChatOf: ThreadId.make("parent") },
        runs: projection.runs.map((run) =>
          run.id === current.id ? { ...freshRun, freshContext: true } : run,
        ),
        contextHandoffs: [handoff],
        turnItems: scheduled
          ? [
              ...projection.turnItems,
              {
                type: "user_message",
                id: TurnItemId.make("scheduled-fresh"),
                threadId: harness.threadId,
                runId: current.id,
                nodeId: null,
                providerThreadId: current.providerThreadId,
                providerTurnId: null,
                nativeItemRef: null,
                parentItemId: null,
                ordinal: 0,
                status: "completed",
                title: null,
                startedAt: projection.updatedAt,
                completedAt: projection.updatedAt,
                updatedAt: projection.updatedAt,
                createdBy: "user",
                creationSource: "server",
                messageId: current.userMessageId,
                text: "Start over",
                inputIntent: "turn_start",
                attachments: [],
                scheduledTaskId: ScheduledTaskId.make("fresh-task"),
              },
            ]
          : projection.turnItems,
      });
      const freshProjection = harness.projection();
      const selected = selectSideChatHandoffs(
        freshProjection,
        freshProjection.runs.find((run) => run.id === harness.runId)!,
      );
      expect(selected.handoffs).toEqual([]);
      expect(selected.retire.map((item) => item.id)).toEqual(scheduled ? [] : [handoff.id]);
      if (scheduled) {
        const continuing = {
          ...freshProjection.runs.find((run) => run.id === harness.runId)!,
          freshContext: false,
        };
        expect(
          selectSideChatHandoffs(freshProjection, continuing).handoffs.map((item) => item.id),
        ).toEqual([handoff.id]);
      }
      yield* harness.start;
      expect(harness.projection().contextHandoffs[0]?.status).toBe(
        scheduled ? "ready" : "superseded",
      );
    }),
);
