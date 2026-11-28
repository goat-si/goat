import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaParser from "effect/SchemaParser";
import * as SchemaTransformation from "effect/SchemaTransformation";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  AgentCursorEvent,
  AgentCursorOwner,
  ComputerUseOverlayPoint,
} from "./computerUseOverlay.ts";
import { DEFAULT_SCREEN_RUN_LIMITS, proxyHopFields } from "./screenCode.ts";

// Screen primitives on the computer use lease stream. A leaf: cua.ts re-exports it and joins the
// request, cancel and cursor updates into its lease update unions.
const primitiveId = TrimmedNonEmptyString.check(Schema.isMaxLength(200));
const boundedJson = (maxBytes: number) =>
  Schema.Json.check(
    Schema.makeFilter(
      (value) => new TextEncoder().encode(JSON.stringify(value)).byteLength <= maxBytes,
    ),
  );
/** The byte cap on a primitive request's args; a host merging calls into one checks it first. */
export const COMPUTER_USE_PRIMITIVE_ARGS_BYTES = 64 * 1024;
const primitiveJson = boundedJson(COMPUTER_USE_PRIMITIVE_ARGS_BYTES);
/**
 * A driver answer's JSON on the primitive channel. A full window read of a busy app (Finder lists
 * hundreds of elements, each with its token, frame and actions, beside the tree's markdown) passes
 * 64 KiB; the screen-run tree budget, not this cap, decides how much of it reaches the agent.
 */
export const COMPUTER_USE_PRIMITIVE_RESULT_BYTES = 1024 * 1024;
/** The result the proxy sends in place of a driver answer over the cap; never a driver's own. */
export const COMPUTER_USE_PRIMITIVE_RESULT_TOO_LARGE = "primitive_reply_too_large";
const strictPrimitive = <S extends Schema.Constraint>(schema: S) =>
  Schema.declareConstructor<S["Type"], S["Encoded"]>()(
    [schema],
    ([codec]) => {
      const decode = SchemaParser.decodeUnknownEffect(codec);
      return (input, _ast, options) => decode(input, { ...options, onExcessProperty: "error" });
    },
    {
      toCodec: ([codec]) => new SchemaAST.Link(codec.ast, SchemaTransformation.passthrough()),
      toCodecJson: () => undefined,
    },
  );
const primitiveCallIdentity = {
  requestId: primitiveId,
  registrationId: primitiveId,
  controlId: primitiveId,
  connectionGeneration: primitiveId,
  runId: primitiveId,
  turnId: primitiveId,
  callId: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })),
};

export const ComputerUsePrimitiveRequest = Schema.Struct({
  state: Schema.Literal("primitive-request"),
  ...primitiveCallIdentity,
  deadlineMillis: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
  tool: primitiveId,
  authority: Schema.optionalKey(Schema.Literal("claimBind")),
  bindingVersion: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  args: primitiveJson,
  /**
   * The agent cursor this call draws, never sent to the driver: the host-owned owner (sequence 0,
   * before any of its phases) and where in the window the call acts, when the host knows.
   */
  cursor: Schema.optionalKey(
    Schema.Struct({ owner: AgentCursorOwner, point: Schema.optionalKey(ComputerUseOverlayPoint) }),
  ),
});
export type ComputerUsePrimitiveRequest = typeof ComputerUsePrimitiveRequest.Type;

/** Cancels a request already delivered to the proxy while admission is still pending. */
export const ComputerUsePrimitiveCancel = Schema.Struct({
  state: Schema.Literal("primitive-cancel"),
  requestId: primitiveId,
});
export type ComputerUsePrimitiveCancel = typeof ComputerUsePrimitiveCancel.Type;

/** Host-origin cursor state on the authenticated proxy stream; never forwarded to the driver. */
export const AgentCursorLeaseUpdate = Schema.Struct({
  state: Schema.Literal("cursor-state"),
  controlId: TrimmedNonEmptyString,
  connectionGeneration: TrimmedNonEmptyString,
  event: AgentCursorEvent,
});
export type AgentCursorLeaseUpdate = typeof AgentCursorLeaseUpdate.Type;

export const ComputerUsePrimitiveReply = strictPrimitive(
  Schema.Struct({
    ...primitiveCallIdentity,
    status: Schema.Literals(["not_started", "settled", "unknown_outcome"]),
    result: Schema.optionalKey(boundedJson(COMPUTER_USE_PRIMITIVE_RESULT_BYTES)),
    error: Schema.optionalKey(primitiveJson),
    image: Schema.optionalKey(
      Schema.Struct({
        mimeType: Schema.Literals(["image/png", "image/jpeg"]),
        bytes: Schema.String.check(
          Schema.isMaxLength(Math.ceil(DEFAULT_SCREEN_RUN_LIMITS.imageBytes / 3) * 4),
          Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
          Schema.makeFilter(
            (value) =>
              (value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0) <=
              DEFAULT_SCREEN_RUN_LIMITS.imageBytes,
          ),
        ),
        width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER })),
        height: Schema.Int.check(
          Schema.isBetween({ minimum: 1, maximum: Number.MAX_SAFE_INTEGER }),
        ),
      }),
    ),
    /** The proxy's own timing of this call; see ScreenHopTimes. */
    hops: Schema.optionalKey(Schema.Struct(proxyHopFields)),
  }),
);
export type ComputerUsePrimitiveReply = typeof ComputerUsePrimitiveReply.Type;

const primitiveControlReport = {
  registrationId: primitiveId,
  controlId: primitiveId,
  connectionId: primitiveId,
  driverGeneration: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
};
export const ComputerUsePrimitiveControlReady = strictPrimitive(
  Schema.Struct(primitiveControlReport),
);
export type ComputerUsePrimitiveControlReady = typeof ComputerUsePrimitiveControlReady.Type;
export const ComputerUsePrimitiveControlCutoff = strictPrimitive(
  Schema.Struct({
    ...primitiveControlReport,
    terminal: Schema.optionalKey(Schema.Literals(["stopped_by_person", "screen_locked"])),
  }),
);
export type ComputerUsePrimitiveControlCutoff = typeof ComputerUsePrimitiveControlCutoff.Type;
