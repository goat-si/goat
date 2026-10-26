import { assert, it } from "@effect/vitest";
import { ComputerUsePrimitiveReply, DEFAULT_SCREEN_RUN_LIMITS } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { primitiveReplySink } from "./ComputerUseLeaseProxyOptions.ts";

const request = {
  state: "primitive-request" as const,
  requestId: "request", registrationId: "registration", controlId: "control",
  connectionGeneration: "driver:1", runId: "run", turnId: "turn", callId: 1,
  deadlineMillis: 1000, tool: "get_window_state", args: {},
};

it.effect("an image over the image cap is refused, not truncated", () =>
  Effect.gen(function* () {
    const bytes = Buffer.alloc(DEFAULT_SCREEN_RUN_LIMITS.imageBytes + 1, 1).toString("base64");
    let received: ComputerUsePrimitiveReply | undefined;
    const sink = primitiveReplySink(request, (reply) => Effect.sync(() => { received = reply; }));
    yield* sink.answer(JSON.stringify({ result: {
      structuredContent: { pid: 42, window_id: 7, screenshot_width: 100, screenshot_height: 100 },
      content: [{ type: "image", mimeType: "image/png", data: bytes }],
    } }), "settled");
    assert.isDefined(received);
    assert.isUndefined(received.image);
    assert.isUndefined(received.result);
    assert.isDefined(received.error);
    assert.isTrue(Schema.is(ComputerUsePrimitiveReply)(received));
  }),
);
