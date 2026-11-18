import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import { makeClaudeEventQueue } from "./ClaudeEventQueue.ts";
import { makeClaudeAssistantTextProjector } from "./ClaudeAssistantText.ts";

type StreamEvent = Extract<SDKMessage, { type: "stream_event" }>["event"];
const event = (value: unknown) => value as StreamEvent;

it("publishes successive paragraphs before the assistant snapshot", () => {
  const projector = makeClaudeAssistantTextProjector();
  projector.stream(event({ type: "message_start", message: { id: "reply" } }));
  projector.stream(
    event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
  );
  assert.equal(
    projector.stream(
      event({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "First paragraph.\n\n" },
      }),
    )[0]?.text,
    "First paragraph.\n\n",
  );
  assert.equal(
    projector.stream(
      event({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Second paragraph.\n\n" },
      }),
    )[0]?.text,
    "First paragraph.\n\nSecond paragraph.\n\n",
  );
});

type Event = ProviderAdapter.ProviderAdapterV2Event;
const assistantEvent = (text: string, streaming: boolean): Event =>
  ({
    type: "turn_item.updated",
    turnItem: { type: "assistant_message", nodeId: "node", text, streaming },
  }) as unknown as Event;
const runningNode = {
  type: "node.updated",
  node: { id: "node", kind: "assistant_message", status: "running" },
} as unknown as Event;

it.effect("bounds queued text for a burst of short lines and completes the reply", () =>
  Effect.gen(function* () {
    const projector = makeClaudeAssistantTextProjector();
    const queue = yield* makeClaudeEventQueue();
    projector.stream(event({ type: "message_start", message: { id: "burst" } }));
    projector.stream(
      event({ type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }),
    );
    for (let i = 0; i < 10_000; i++) {
      for (const update of projector.stream(
        event({
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "x\n" },
        }),
      )) {
        yield* queue.offer(runningNode);
        yield* queue.offer(assistantEvent(update.text, update.streaming));
      }
    }
    for (const update of projector.stream(event({ type: "content_block_stop", index: 0 })))
      yield* queue.offer(assistantEvent(update.text, update.streaming));
    const sentinel = { type: "sentinel" } as unknown as Event;
    yield* queue.offer(sentinel);
    const node = yield* queue.take;
    const partial = yield* queue.take;
    const final = yield* queue.take;
    assert.strictEqual(yield* queue.take, sentinel);
    assert.equal(node.type, "node.updated");
    assert.equal(partial.type, "turn_item.updated");
    assert.equal(final.type, "turn_item.updated");
    if (
      partial.type !== "turn_item.updated" ||
      partial.turnItem.type !== "assistant_message" ||
      final.type !== "turn_item.updated" ||
      final.turnItem.type !== "assistant_message"
    )
      throw new Error("Expected assistant text events");
    assert.isAtMost(partial.turnItem.text.length + final.turnItem.text.length, 60_000);
    assert.equal(partial.turnItem.text, "x\n".repeat(10_000));
    assert.equal(final.turnItem.text, "x\n".repeat(10_000));
    assert.isFalse(final.turnItem.streaming);
  }),
);

it.effect("preserves tool boundaries and publishes new text after a drain", () =>
  Effect.gen(function* () {
    const queue = yield* makeClaudeEventQueue();
    const tool = { type: "tool.boundary" } as unknown as Event;
    yield* queue.offer(assistantEvent("first\n", true));
    yield* queue.offer(assistantEvent("first\nsecond\n", true));
    yield* queue.offer(tool);
    yield* queue.offer(assistantEvent("after tool\n", true));
    const first = yield* queue.take;
    assert.equal(
      first.type === "turn_item.updated" &&
        first.turnItem.type === "assistant_message" &&
        first.turnItem.text,
      "first\nsecond\n",
    );
    assert.strictEqual(yield* queue.take, tool);
    const second = yield* queue.take;
    assert.equal(
      second.type === "turn_item.updated" &&
        second.turnItem.type === "assistant_message" &&
        second.turnItem.text,
      "after tool\n",
    );
    yield* queue.offer(assistantEvent("later\n", true));
    const later = yield* queue.take;
    assert.equal(
      later.type === "turn_item.updated" &&
        later.turnItem.type === "assistant_message" &&
        later.turnItem.text,
      "later\n",
    );
  }),
);
