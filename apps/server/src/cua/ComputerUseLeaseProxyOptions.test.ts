import { assert, it } from "@effect/vitest";
import { ComputerUsePrimitiveReply, DEFAULT_SCREEN_RUN_LIMITS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { primitiveReplySink } from "./ComputerUseLeaseProxyOptions.ts";

const isComputerUsePrimitiveReply = Schema.is(ComputerUsePrimitiveReply);

const request = {
  state: "primitive-request" as const,
  requestId: "request",
  registrationId: "registration",
  controlId: "control",
  connectionGeneration: "driver:1",
  runId: "run",
  turnId: "turn",
  callId: 1,
  deadlineMillis: 1000,
  tool: "get_window_state",
  args: {},
};

it.effect("an image over the image cap is refused, not truncated", () =>
  Effect.gen(function* () {
    const bytes = Buffer.alloc(DEFAULT_SCREEN_RUN_LIMITS.imageBytes + 1, 1).toString("base64");
    let received: ComputerUsePrimitiveReply | undefined;
    const sink = primitiveReplySink(request, (reply) =>
      Effect.sync(() => {
        received = reply;
      }),
    );
    yield* sink.answer(
      JSON.stringify({
        result: {
          structuredContent: {
            pid: 42,
            window_id: 7,
            screenshot_width: 100,
            screenshot_height: 100,
          },
          content: [{ type: "image", mimeType: "image/png", data: bytes }],
        },
      }),
      "settled",
    );
    assert.isDefined(received);
    assert.isUndefined(received.image);
    assert.isUndefined(received.result);
    assert.isDefined(received.error);
    assert.isTrue(isComputerUsePrimitiveReply(received));
  }),
);

// Cua Driver 0.38 over MCP puts a window read's state in a JSON text block when the reply carries
// an image, with no structuredContent: the Linux screenshots screen-run asked for were refused.
it.effect("a window read whose state comes as JSON text beside its image keeps both", () =>
  Effect.gen(function* () {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").toString("base64");
    let received: ComputerUsePrimitiveReply | undefined;
    const sink = primitiveReplySink(request, (reply) =>
      Effect.sync(() => {
        received = reply;
      }),
    );
    const state = { pid: 42, window_id: 7, screenshot_width: 100, screenshot_height: 80 };
    yield* sink.answer(
      JSON.stringify({
        result: {
          content: [
            { type: "image", mimeType: "image/png", data: png },
            { type: "text", text: JSON.stringify(state) },
          ],
        },
      }),
      "settled",
    );
    assert.isTrue(isComputerUsePrimitiveReply(received));
    assert.deepInclude(received?.image, { mimeType: "image/png", width: 100, height: 80 });
    assert.deepInclude(
      (received?.result as { structuredContent?: unknown })?.structuredContent,
      state,
    );
  }),
);
