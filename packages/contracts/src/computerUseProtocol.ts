import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The computer use helper protocol: one contract for the native helper on every platform (D8 in
 * epic #1140). A helper observes and acts on one exact window of one process. Methods it cannot
 * serve answer with a typed "unsupported" refusal, and its capabilities name every method, so a
 * helper cannot silently lack one.
 *
 * Screenshots never travel inside these values: a result carries the image's metadata, and the
 * MCP surface returns its bytes as a content image block, never in structuredContent (D3).
 */

export const COMPUTER_USE_PROTOCOL_VERSION = 1;

export const ComputerUsePlatform = Schema.Literals(["mac", "windows", "linux"]);
export type ComputerUsePlatform = typeof ComputerUsePlatform.Type;

export const COMPUTER_USE_ACTIONS = [
  "click",
  "doubleClick",
  "rightClick",
  "typeText",
  "pressKey",
  "scroll",
  "drag",
  "setValue",
  "performAction",
] as const;
export const ComputerUseActionKind = Schema.Literals(COMPUTER_USE_ACTIONS);
export type ComputerUseActionKind = typeof ComputerUseActionKind.Type;

export const COMPUTER_USE_METHODS = [
  "capabilities",
  "permissions",
  "listWindows",
  "observe",
  ...COMPUTER_USE_ACTIONS,
] as const;
export const ComputerUseMethod = Schema.Literals(COMPUTER_USE_METHODS);
export type ComputerUseMethod = typeof ComputerUseMethod.Type;

const Support = Schema.Literals(["supported", "unsupported"]);

/** What a helper serves. Decoding fails unless every method is named. */
export const ComputerUseCapabilities = Schema.Struct({
  protocol: Schema.Number,
  platform: ComputerUsePlatform,
  methods: Schema.Struct(
    Object.fromEntries(COMPUTER_USE_METHODS.map((method) => [method, Support])) as {
      readonly [M in ComputerUseMethod]: typeof Support;
    },
  ),
  /** Input that reaches a window without raising it; foreground input always needs a lease. */
  backgroundDelivery: Schema.Boolean,
});
export type ComputerUseCapabilities = typeof ComputerUseCapabilities.Type;

export const ComputerUsePermissions = Schema.Struct({
  /** Accessibility (macOS), UI Automation access (Windows), AT-SPI (Linux). */
  accessibility: Schema.Boolean,
  screenCapture: Schema.Boolean,
});
export type ComputerUsePermissions = typeof ComputerUsePermissions.Type;

/** One exact window of one process. */
export const ComputerUseWindowTarget = Schema.Struct({
  pid: Schema.Int,
  windowId: Schema.Int,
});
export type ComputerUseWindowTarget = typeof ComputerUseWindowTarget.Type;

/**
 * Names the window's identity as the helper last saw it: the window itself, its Space or virtual
 * desktop and display. Opaque; any change invalidates every element ref issued under it.
 */
export const ComputerUseTargetEpoch = TrimmedNonEmptyString;

export const ComputerUseWindow = Schema.Struct({
  ...ComputerUseWindowTarget.fields,
  title: Schema.optionalKey(Schema.String),
  /** Bundle id (macOS), executable name (Windows), or desktop file id (Linux). */
  application: Schema.optionalKey(Schema.String),
  onScreen: Schema.Boolean,
});
export type ComputerUseWindow = typeof ComputerUseWindow.Type;

export const ComputerUseRect = Schema.Struct({
  x: Schema.Number,
  y: Schema.Number,
  width: Schema.Number,
  height: Schema.Number,
});

/**
 * An element ref stays the same across diff observations of one lineage. A full observation
 * starts a new lineage, and refs from an older one are stale.
 */
export const ComputerUseElementRef = TrimmedNonEmptyString;

export const ComputerUseElement = Schema.Struct({
  ref: ComputerUseElementRef,
  role: Schema.String,
  label: Schema.optionalKey(Schema.String),
  /** Withheld for secure fields. */
  value: Schema.optionalKey(Schema.String),
  actions: Schema.Array(Schema.String),
  /** Window-local screenshot pixels. */
  frame: Schema.optionalKey(ComputerUseRect),
  parent: Schema.optionalKey(ComputerUseElementRef),
  /** A password field or an equivalent the platform marks secure. */
  secure: Schema.optionalKey(Schema.Boolean),
});
export type ComputerUseElement = typeof ComputerUseElement.Type;

/** Why an observation is full instead of a diff (D4). */
export const ComputerUseFullReason = Schema.Literals([
  "first",
  "unknown_since",
  /** The read used another query or limits, so what it lacks says nothing about the window. */
  "scope_changed",
  "reordered",
  "incomplete",
  "window_changed",
  "epoch_changed",
]);

const ObservationFields = {
  observationId: TrimmedNonEmptyString,
  lineage: TrimmedNonEmptyString,
  target: Schema.Struct({ ...ComputerUseWindowTarget.fields, epoch: ComputerUseTargetEpoch }),
  /** False when the tree walk stopped early; the next observation is then full. */
  complete: Schema.Boolean,
  focused: Schema.optionalKey(ComputerUseElementRef),
  /**
   * A secure field has focus (D6). The helper withholds the screenshot and values, and refuses
   * actions with privateMode until it loses focus.
   */
  privateMode: Schema.Boolean,
  /** The image travels separately as MCP content; absent when withheld or not requested. */
  screenshot: Schema.optionalKey(
    Schema.Struct({ mimeType: Schema.String, width: Schema.Int, height: Schema.Int }),
  ),
  degraded: Schema.optionalKey(Schema.String),
};

export const ComputerUseObservation = Schema.Union([
  Schema.Struct({
    ...ObservationFields,
    kind: Schema.Literal("full"),
    reason: ComputerUseFullReason,
    elements: Schema.Array(ComputerUseElement),
  }),
  Schema.Struct({
    ...ObservationFields,
    kind: Schema.Literal("diff"),
    since: TrimmedNonEmptyString,
    added: Schema.Array(ComputerUseElement),
    changed: Schema.Array(ComputerUseElement),
    /**
     * Refs this read did not see. Accessibility reads can miss nodes, so this is "not seen",
     * not proof of deletion; the refs are stale either way, and an element that returns gets a
     * new ref.
     */
    removed: Schema.Array(ComputerUseElementRef),
  }),
]);
export type ComputerUseObservation = typeof ComputerUseObservation.Type;

export const ComputerUseObserveRequest = Schema.Struct({
  target: ComputerUseWindowTarget,
  /** The last observation of this window; the helper returns a diff when it still can. */
  since: Schema.optionalKey(TrimmedNonEmptyString),
  screenshot: Schema.Boolean,
  query: Schema.optionalKey(Schema.String),
  maxElements: Schema.optionalKey(Schema.Int),
});
export type ComputerUseObserveRequest = typeof ComputerUseObserveRequest.Type;

/** Background first; foreground only when asked for and the lease allows it (D5, D7). */
export const ComputerUseDelivery = Schema.Literals(["background", "foreground"]);
export type ComputerUseDelivery = typeof ComputerUseDelivery.Type;

/** Where an action lands: an element ref, or a point in that observation's screenshot. */
export const ComputerUseActionPoint = Schema.Union([
  Schema.Struct({ element: ComputerUseElementRef }),
  Schema.Struct({ x: Schema.Number, y: Schema.Number }),
]);

const ActionFields = {
  target: Schema.Struct({ ...ComputerUseWindowTarget.fields, epoch: ComputerUseTargetEpoch }),
  /** The observation the agent acted on; refs and points are read against it. */
  observationId: TrimmedNonEmptyString,
  delivery: ComputerUseDelivery,
};

/**
 * Modifier keys by role, not by label: option is Alt on Windows and Linux, and command is the
 * Windows key on Windows and Super on Linux. Each helper maps them to its platform's keys.
 */
const Modifiers = Schema.Array(Schema.Literals(["shift", "control", "option", "command"]));

/**
 * One key by what it means, not by keycode: a single printable character as typed without
 * modifiers ("a", "7", "/"), or a named key. Helpers translate it for the active layout.
 */
export const ComputerUseKey = Schema.Union([
  Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(1)),
  Schema.Literals([
    "enter",
    "tab",
    "escape",
    "backspace",
    "delete",
    "space",
    "arrowUp",
    "arrowDown",
    "arrowLeft",
    "arrowRight",
    "home",
    "end",
    "pageUp",
    "pageDown",
    ...Array.from({ length: 20 }, (_, index) => `f${index + 1}` as const),
  ]),
]);
export type ComputerUseKey = typeof ComputerUseKey.Type;

export const ComputerUseActionRequest = Schema.Union([
  Schema.Struct({
    ...ActionFields,
    action: Schema.Literals(["click", "doubleClick", "rightClick"]),
    at: ComputerUseActionPoint,
    modifiers: Schema.optionalKey(Modifiers),
  }),
  Schema.Struct({
    ...ActionFields,
    action: Schema.Literal("typeText"),
    text: Schema.String,
    at: Schema.optionalKey(ComputerUseActionPoint),
  }),
  Schema.Struct({
    ...ActionFields,
    action: Schema.Literal("pressKey"),
    /** A key or a chord: press the modifiers, press and release key, release the modifiers. */
    key: ComputerUseKey,
    modifiers: Schema.optionalKey(Modifiers),
  }),
  Schema.Struct({
    ...ActionFields,
    action: Schema.Literal("scroll"),
    at: ComputerUseActionPoint,
    direction: Schema.Literals(["up", "down", "left", "right"]),
    /** In lines, the unit one mouse-wheel notch scrolls on each platform. */
    amount: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })),
  }),
  Schema.Struct({
    ...ActionFields,
    action: Schema.Literal("drag"),
    from: ComputerUseActionPoint,
    to: ComputerUseActionPoint,
  }),
  Schema.Struct({
    ...ActionFields,
    action: Schema.Literal("setValue"),
    element: ComputerUseElementRef,
    value: Schema.String,
    append: Schema.optionalKey(Schema.Boolean),
  }),
  Schema.Struct({
    ...ActionFields,
    action: Schema.Literal("performAction"),
    element: ComputerUseElementRef,
    /** A name from the element's actions, such as AXPress or Invoke. */
    name: TrimmedNonEmptyString,
  }),
]);
export type ComputerUseActionRequest = typeof ComputerUseActionRequest.Type;

/**
 * Why a helper did nothing; nothing was dispatched. Each names its own cause: a policy refusal
 * (targetRefused, appNotAllowed) or a missing permission is never reported as the person
 * stopping the session (userStoppedSession) or taking over (userIntervened) (#1146, D10).
 */
export const ComputerUseRefusalReason = Schema.Literals([
  // D10, shared with the approvals and onboarding work (T4).
  "userStoppedSession",
  "userIntervened",
  "screenLocked",
  "permissionsNotGranted",
  "permissionsPending",
  "appNotAllowed",
  "blockedURL",
  "incompatibleClientVersion",
  "targetRefused",
  // Observation and targeting (D4, D5).
  "staleElement",
  "epochChanged",
  "windowNotFound",
  "ownerMismatch",
  "targetGone",
  "privateMode",
  "leaseRequired",
  "foregroundNotAllowed",
  /** Background input cannot reach this window; foreground delivery is the caller's choice. */
  "backgroundUnavailable",
  // The channel itself.
  "unsupported",
  "invalidRequest",
  "frameTooLarge",
  "busy",
  "helperUnavailable",
]);
export type ComputerUseRefusalReason = typeof ComputerUseRefusalReason.Type;

export const ComputerUseRefusal = Schema.Struct({
  outcome: Schema.Literal("refused"),
  reason: ComputerUseRefusalReason,
  message: Schema.String,
  /** For unsupported: the method and platform that lack it. */
  method: Schema.optionalKey(ComputerUseMethod),
  platform: Schema.optionalKey(ComputerUsePlatform),
});
export type ComputerUseRefusal = typeof ComputerUseRefusal.Type;

const SentFields = {
  delivery: ComputerUseDelivery,
  detail: Schema.optionalKey(Schema.String),
  /** What changed, as a diff of the observation the action named. */
  observation: Schema.optionalKey(ComputerUseObservation),
};

/**
 * What happened to input the helper sent. dispatch says whether the helper saw the effect
 * (verified) or only knows input left (dispatched_unknown). Only pairs that make sense decode:
 * confirmed and suspected_noop were seen, unverifiable was not, partial may be either. Input
 * that never left is a refusal, never an outcome.
 */
export const ComputerUseActionResult = Schema.Union([
  Schema.Struct({
    ...SentFields,
    outcome: Schema.Literals(["confirmed", "suspected_noop"]),
    dispatch: Schema.Literal("verified"),
  }),
  Schema.Struct({
    ...SentFields,
    outcome: Schema.Literal("partial"),
    dispatch: Schema.Literals(["dispatched_unknown", "verified"]),
  }),
  Schema.Struct({
    ...SentFields,
    outcome: Schema.Literal("unverifiable"),
    dispatch: Schema.Literal("dispatched_unknown"),
  }),
  ComputerUseRefusal,
]);
export type ComputerUseActionResult = typeof ComputerUseActionResult.Type;

const REOBSERVE_REASONS: ReadonlySet<ComputerUseRefusalReason> = new Set([
  "staleElement",
  "epochChanged",
  "windowNotFound",
  "ownerMismatch",
]);

/**
 * What the caller may do after an action (D5). Only a refusal that dispatched nothing for a
 * transient reason may be sent again as is. partial and unverifiable input may have landed, so it
 * is never replayed: the agent observes again and decides.
 */
export function computerUseNextStep(
  result: ComputerUseActionResult,
): "done" | "observe" | "retry" | "stop" {
  if (result.outcome === "confirmed") return "done";
  if (result.outcome !== "refused") return "observe";
  if (result.reason === "busy") return "retry";
  return REOBSERVE_REASONS.has(result.reason) ? "observe" : "stop";
}

export const unsupportedComputerUseMethod = (
  method: ComputerUseMethod,
  platform: ComputerUsePlatform,
): ComputerUseRefusal => ({
  outcome: "refused",
  reason: "unsupported",
  message: `${method} is not available on ${platform}.`,
  method,
  platform,
});

/**
 * A request whose deadline passed may still have reached the target, so the caller reports it as
 * unverifiable and observes again; it is never a refusal and never replayed.
 */
export const computerUseDeadlineResult = (
  delivery: ComputerUseDelivery,
): ComputerUseActionResult => ({
  outcome: "unverifiable",
  dispatch: "dispatched_unknown",
  delivery,
  detail: "The helper did not answer before the deadline.",
});

/** Largest frame either side may send; larger ones are refused with frameTooLarge. */
export const COMPUTER_USE_MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** One helper process: a reply is trusted only from the process and generation it came from. */
export const ComputerUseHelperBinding = Schema.Struct({
  executable: TrimmedNonEmptyString,
  pid: Schema.Int,
  /** Changes on every helper start, restart or update. */
  generation: TrimmedNonEmptyString,
});
export type ComputerUseHelperBinding = typeof ComputerUseHelperBinding.Type;

/** The client's first frame. */
export const ComputerUseHello = Schema.Struct({
  clientApiVersion: Schema.Int,
});

/** The helper's answer: its own version, identity and limits, or incompatibleClientVersion. */
export const ComputerUseHelloReply = Schema.Union([
  Schema.Struct({
    serverApiVersion: Schema.Int,
    binding: ComputerUseHelperBinding,
    capabilities: ComputerUseCapabilities,
    /** At most COMPUTER_USE_MAX_FRAME_BYTES; both sides then enforce the smaller limit. */
    maxFrameBytes: Schema.Int.check(
      Schema.isBetween({ minimum: 64 * 1024, maximum: COMPUTER_USE_MAX_FRAME_BYTES }),
    ),
  }),
  ComputerUseRefusal,
]);
export type ComputerUseHelloReply = typeof ComputerUseHelloReply.Type;

export const ComputerUseRequestFrame = Schema.Struct({
  id: TrimmedNonEmptyString,
  generation: TrimmedNonEmptyString,
  method: ComputerUseMethod,
  /** Milliseconds the helper may spend; past it the client stops waiting. */
  deadlineMs: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 * 60 * 1000 })),
  params: Schema.Unknown,
});
export type ComputerUseRequestFrame = typeof ComputerUseRequestFrame.Type;

export const ComputerUseReplyFrame = Schema.Struct({
  id: TrimmedNonEmptyString,
  generation: TrimmedNonEmptyString,
  result: Schema.Unknown,
});
export type ComputerUseReplyFrame = typeof ComputerUseReplyFrame.Type;

/**
 * Whether a reply may reach the caller. Replies from another generation, to a request no longer
 * pending (answered, timed out, or cancelled by stop), or oversized are quarantined: logged by
 * the client and never delivered (D10).
 */
export function admitComputerUseReply(input: {
  readonly reply: ComputerUseReplyFrame;
  readonly frameBytes: number;
  /** The limit the hello agreed on, never above COMPUTER_USE_MAX_FRAME_BYTES. */
  readonly maxFrameBytes: number;
  readonly generation: string;
  readonly pending: ReadonlySet<string>;
}): "deliver" | "wrongGeneration" | "notPending" | "frameTooLarge" {
  if (input.frameBytes > Math.min(input.maxFrameBytes, COMPUTER_USE_MAX_FRAME_BYTES))
    return "frameTooLarge";
  if (input.reply.generation !== input.generation) return "wrongGeneration";
  return input.pending.has(input.reply.id) ? "deliver" : "notPending";
}

/** The version this client speaks against the helper's; a mismatch refuses before any work. */
export function negotiateComputerUseVersion(serverApiVersion: number): true | ComputerUseRefusal {
  return serverApiVersion === COMPUTER_USE_PROTOCOL_VERSION
    ? true
    : {
        outcome: "refused",
        reason: "incompatibleClientVersion",
        message:
          "GOAT speaks computer use protocol " +
          COMPUTER_USE_PROTOCOL_VERSION +
          " and the helper speaks " +
          serverApiVersion +
          ". Update GOAT so both match.",
      };
}
