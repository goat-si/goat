import { assert } from "@effect/vitest";
import { RunAttemptId, type OrchestrationV2ProviderThread, type ThreadId } from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as CodexReplay from "effect-codex-app-server/replay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { codexReplayPreamble, makeCodexReplayTranscript } from "./CodexReplay.testkit.ts";
import { makeCodexTestTurnInput } from "./CodexAdapterV2.testkit.ts";
import * as Predicate from "effect/Predicate";
import { buildCodexDevelopmentContext } from "../../provider/CodexDeveloperInstructions.ts";

const nativeThreadId = "receipt-native";
const nativeTurnId = "receipt-turn";
export function codexReceiptTranscript(
  seal: "newline" | "tool",
  barrier: (id: string) => CodexReplay.CodexAppServerReplayEntry,
) {
  const notification = (method: string, params: Record<string, unknown>) => ({
    type: "emit_inbound" as const,
    frame: { method, params: { threadId: nativeThreadId, turnId: nativeTurnId, ...params } },
  });
  return makeCodexReplayTranscript({
    scenario: "receipt-" + seal,
    entries: [
      ...codexReplayPreamble({ nativeThreadId, nativeTurnId, prompt: "Check" }).map((entry) =>
        entry.type === "expect_outbound" &&
        Predicate.isObject(entry.frame) &&
        entry.frame.method === "turn/start" &&
        Predicate.isObject(entry.frame.params)
          ? {
              ...entry,
              frame: {
                ...entry.frame,
                params: {
                  ...entry.frame.params,
                  collaborationMode: { mode: "default", settings: { model: "gpt-5.4" } },
                  additionalContext: buildCodexDevelopmentContext(),
                },
              },
            }
          : entry,
      ),
      notification("item/agentMessage/delta", {
        itemId: "receipt",
        delta: seal === "newline" ? "Checking\n" : "Checking",
      }),
      ...(seal === "tool"
        ? [
            notification("item/started", {
              startedAtMs: 1782622440000,
              item: {
                type: "webSearch",
                id: "search",
                query: "goat",
                action: null,
              },
            }),
          ]
        : []),
      barrier(nativeThreadId),
    ],
  });
}

export const verifyCodexReceipt = Effect.fn("CodexReceipt.verify")(function* (
  harness: {
    runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
    providerThread: OrchestrationV2ProviderThread;
    threadId: ThreadId;
    events: ProviderAdapter.ProviderAdapterV2Event[];
    consumerBarrier: Effect.Effect<void>;
  },
  seal: "newline" | "tool",
) {
  yield* harness.runtime.startTurn(
    makeCodexTestTurnInput({
      threadId: harness.threadId,
      providerThread: harness.providerThread,
      now: yield* DateTime.now,
      text: "Check",
      attemptId: RunAttemptId.make("receipt"),
    }),
  );
  yield* harness.consumerBarrier;
  const text = harness.events.findIndex(
    (event) => event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
  );
  assert.isAtLeast(text, 0, "opening assistant text must publish while the item remains open");
  const event = harness.events[text];
  if (event?.type === "turn_item.updated" && event.turnItem.type === "assistant_message") {
    assert.equal(event.turnItem.text, seal === "newline" ? "Checking\n" : "Checking");
    assert.isTrue(event.turnItem.streaming);
    assert.isNull(event.turnItem.completedAt);
  }
  if (seal === "tool") {
    const tool = harness.events.findIndex(
      (event) => event.type === "node.updated" && event.node.kind === "tool_call",
    );
    assert.isAbove(tool, text, "text must publish before the root tool");
  }
});
