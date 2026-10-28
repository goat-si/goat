import { assert, it } from "@effect/vitest";
import {
  COMPUTER_USE_PRIMITIVE_RESULT_BYTES,
  COMPUTER_USE_PRIMITIVE_RESULT_TOO_LARGE,
  ComputerUsePrimitiveReply,
  DEFAULT_SCREEN_RUN_LIMITS,
} from "@goat/contracts";
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

// A Finder window read in full: hundreds of rows, each with its token, frame and actions.
it.effect("a window read over 64 KiB reaches the server whole; one over the cap says so", () =>
  Effect.gen(function* () {
    const received: Array<ComputerUsePrimitiveReply> = [];
    const sink = primitiveReplySink(request, (reply) =>
      Effect.sync(() => void received.push(reply)),
    );
    const elements = Array.from({ length: 800 }, (_, index) => ({
      role: "AXRow",
      label: `Recents item ${index}`,
      element_index: index,
      element_token: `s0000000a:${index}`,
      frame: { x: 0, y: index * 20, w: 400, h: 20 },
      actions: ["press", "show_menu"],
    }));
    const finder = { pid: 878, window_id: 72907, elements };
    assert.isAbove(Buffer.byteLength(JSON.stringify(finder)), 64 * 1024);
    yield* sink.answer(JSON.stringify({ result: { structuredContent: finder } }), "settled");
    const huge = { ...finder, tree_markdown: "x".repeat(COMPUTER_USE_PRIMITIVE_RESULT_BYTES) };
    yield* sink.answer(JSON.stringify({ result: { structuredContent: huge } }), "settled");
    const [whole, capped] = received;
    assert.isTrue(isComputerUsePrimitiveReply(whole));
    assert.deepInclude((whole?.result as { structuredContent?: object })?.structuredContent, {
      pid: 878,
      window_id: 72907,
    });
    assert.isTrue(isComputerUsePrimitiveReply(capped));
    assert.equal(
      (capped?.result as { code?: unknown })?.code,
      COMPUTER_USE_PRIMITIVE_RESULT_TOO_LARGE,
    );
    // A driver failure over the cap still reads as a failure.
    yield* sink.answer(
      JSON.stringify({ result: { isError: true, structuredContent: huge } }),
      "settled",
    );
    assert.deepInclude(received[2]?.result as object, {
      code: COMPUTER_USE_PRIMITIVE_RESULT_TOO_LARGE,
      isError: true,
    });
  }),
);
