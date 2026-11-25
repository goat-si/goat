import { it } from "@effect/vitest";
import { ContextHandoffId, ContextTransferId, MessageId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";
import { makeLocalCommandHarness } from "./ProviderTurnStartService.localCommand.testkit.ts";
import { selectSideChatHandoffs } from "./SideChatHandoffSelection.ts";

it.effect.each(["/goal ship it", "/compact"])(
  "regression: a side chat's parent context deferred by %s reaches the next turn",
  (command) =>
    Effect.gen(function* () {
      const harness = makeLocalCommandHarness({
        text: "Now look at the tests",
        previousTurn: { runStatus: "completed", turnStatus: "completed" },
      });
      const projection = harness.projection();
      const previous = projection.runs[0]!;
      const current = projection.runs.find((run) => run.id === harness.runId)!;
      const template = projection.messages[0]!;
      const commandMessageId = MessageId.make("side-chat-command");
      const handoff = {
        id: ContextHandoffId.make("side-chat-deferred-handoff"),
        transferId: ContextTransferId.make("side-chat-deferred-transfer"),
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
          run.id === previous.id ? { ...run, userMessageId: commandMessageId } : run,
        ),
        messages: [
          { ...template, id: commandMessageId, runId: previous.id, text: command },
          ...projection.messages,
        ],
        contextHandoffs: [handoff],
      });
      const next = harness.projection();
      const selected = selectSideChatHandoffs(
        next,
        next.runs.find((run) => run.id === harness.runId)!,
      );
      expect(selected.handoffs.map((item) => item.id)).toEqual([handoff.id]);
    }),
);
