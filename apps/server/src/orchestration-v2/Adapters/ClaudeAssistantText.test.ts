import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { assert, it } from "@effect/vitest";
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
