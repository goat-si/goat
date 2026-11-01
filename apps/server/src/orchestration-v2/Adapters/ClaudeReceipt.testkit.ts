import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert } from "@effect/vitest";
import { RunAttemptId, type OrchestrationV2ProviderThread, type ThreadId } from "@goat/contracts";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { makeClaudeTestTurnInput } from "./ClaudeTestInput.testkit.ts";

export const verifyClaudeReceipt = Effect.fn("ClaudeReceipt.verify")(function* (
  harness: {
    runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
    providerThread: OrchestrationV2ProviderThread;
    threadId: ThreadId;
    events: ProviderAdapter.ProviderAdapterV2Event[];
    offerAndWait: (message: SDKMessage) => Effect.Effect<void>;
  },
  scenario: "open" | "mixed" | "reconcile" | "nested",
) {
  yield* harness.runtime.startTurn(
    makeClaudeTestTurnInput({
      threadId: harness.threadId,
      providerThread: harness.providerThread,
      now: yield* DateTime.now,
      attemptId: RunAttemptId.make("receipt"),
      text: "Check",
      attachments: [],
    }),
  );
  // Native replay frames intentionally omit unrelated SDK metadata.
  const frame = (value: unknown) => value as SDKMessage;
  const stream = (event: unknown) =>
    frame({
      type: "stream_event",
      event,
      uuid: "stream",
      session_id: "native-session",
      parent_tool_use_id: scenario === "nested" ? "child" : null,
    });
  if (scenario !== "mixed") {
    for (const event of [
      { type: "message_start", message: { id: "receipt-message" } },
      { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
      { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Checking\n" } },
    ])
      yield* harness.offerAndWait(stream(event));
    const opening = harness.events.filter(
      (event) => event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
    );
    assert.lengthOf(
      opening,
      scenario === "nested" ? 0 : 1,
      "open text block must publish its sealed first line",
    );
    if (scenario === "open" || scenario === "nested") return;
    yield* harness.offerAndWait(stream({ type: "content_block_stop", index: 0 }));
  }
  const snapshot = frame({
    type: "assistant",
    uuid: "receipt-snapshot",
    session_id: "native-session",
    parent_tool_use_id: null,
    message: {
      id: "receipt-message",
      model: "claude-sonnet-4-6",
      content:
        scenario === "mixed"
          ? [
              { type: "text", text: "Checking\n" },
              { type: "tool_use", id: "read", name: "Read", input: { file_path: "/workspace/a" } },
              { type: "text", text: "After" },
            ]
          : [{ type: "text", text: "Checking\n" }],
    },
  });
  yield* harness.offerAndWait(snapshot);
  yield* harness.offerAndWait(snapshot);
  const items = harness.events.flatMap((event) =>
    event.type === "turn_item.updated" ? [event.turnItem] : [],
  );
  const completed = items.filter((item) => item.type === "assistant_message" && !item.streaming);
  assert.deepEqual(
    completed.map((item) => (item.type === "assistant_message" ? item.text : "")),
    scenario === "mixed" ? ["Checking\n", "After"] : ["Checking\n"],
  );
  if (scenario === "mixed") {
    assert.deepEqual(
      items.map((item) => item.type),
      ["assistant_message", "dynamic_tool", "assistant_message"],
    );
  } else {
    assert.equal(
      new Set(items.filter((item) => item.type === "assistant_message").map((item) => item.id))
        .size,
      1,
    );
  }
});
