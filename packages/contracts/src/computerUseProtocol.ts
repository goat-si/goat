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
  "watch",
  "unwatch",
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
  /**
   * The safety signals the helper can raise while watching (#1235). The server refuses
   * unattended computer use on a host whose helper lacks either; interactive turns go ahead
   * with the gap shown.
   */
  signals: Schema.Struct({
    /** A secure field (password, passkey prompt) has focus in a watched window. */
    privateMode: Support,
    /** A person's own keyboard or pointer input reached the desktop. */
    humanInput: Support,
  }),
});
export type ComputerUseCapabilities = typeof ComputerUseCapabilities.Type;

/**
 * Where one OS grant stands. pending: asked and not answered yet (an open prompt or portal
 * dialog). denied: the person refused. abandoned: a prompt closed without an answer.
 */
export const ComputerUseGrant = Schema.Literals([
  "granted",
  "pending",
  "denied",
  "abandoned",
  "unknown",
]);
export type ComputerUseGrant = typeof ComputerUseGrant.Type;

/**
 * The helper's answer to permissions: each readiness step on its own, so setup never shows an
 * unproven step as done (D10). Whether the model may use the tool is decided by the server from
 * the thread's attachment and lease, so it is not part of the helper's answer.
 */
export const ComputerUseReadiness = Schema.Struct({
  grants: Schema.Struct({
    /** Accessibility (macOS), UI Automation access (Windows), AT-SPI (Linux). */
    accessibility: ComputerUseGrant,
    screenCapture: ComputerUseGrant,
  }),
  /** incompatible: the hello failed version negotiation. */
  helper: Schema.Literals(["authenticated", "unauthenticated", "incompatible"]),
  /** Proven by a real capture: blank is an all-black frame, noWindow had nothing to capture. */
  capture: Schema.Literals(["ready", "blank", "noWindow", "pending", "unavailable"]),
  /** Proven by a real tree read of a window. */
  tree: Schema.Literals(["ready", "empty", "unavailable"]),
  input: Schema.Literals(["background", "foregroundOnly", "unavailable"]),
  /**
   * What stops computer use right now even when every step above is ready, typed so clients
   * can choose the remedy: screenLocked (unlock the screen), userIntervened (a person has the
   * input), noInteractiveDesktop (a service or SSH session with no desktop, such as Windows
   * Session 0), otherUserAtConsole, restartRequired (a grant changed and the helper must start
   * again to see it).
   */
  blockers: Schema.Array(
    Schema.Literals([
      "screenLocked",
      "userIntervened",
      "noInteractiveDesktop",
      "otherUserAtConsole",
      "restartRequired",
    ]),
  ),
  /** Written for the person setting it up, one per step that is not ready. */
  reasons: Schema.Array(Schema.String),
  /**
   * Who the helper is to the OS, for diagnosing a grant that shows on in System Settings but
   * reads off (#1243): an entry left by an earlier build with another code identity, or a
   * responsible process that is not the helper.
   */
  diagnostics: Schema.optionalKey(
    Schema.Struct({
      executable: TrimmedNonEmptyString,
      pid: Schema.Int,
      /** The process the OS charges grants to; the helper itself once it disclaimed. */
      responsiblePid: Schema.optionalKey(Schema.Int),
      /** The running code's designated requirement (macOS) or its equivalent. */
      codeRequirement: Schema.optionalKey(Schema.String),
      /** The raw accessibility trust answer for this process, before any interpretation. */
      accessibilityTrusted: Schema.Boolean,
    }),
  ),
  platform: Schema.optionalKey(
    Schema.Struct({
      linux: Schema.optionalKey(
        Schema.Struct({ displayServer: Schema.Literals(["x11", "wayland", "xwayland"]) }),
      ),
    }),
  ),
});
export type ComputerUseReadiness = typeof ComputerUseReadiness.Type;

/**
 * Whether the helper can observe and act now: both grants given, the helper authenticated,
 * capture and the tree proven by real reads, some input route, and nothing blocking. Anything
 * less is not ready, whatever the reasons say.
 */
export const computerUseReady = (readiness: ComputerUseReadiness): boolean =>
  readiness.grants.accessibility === "granted" &&
  readiness.grants.screenCapture === "granted" &&
  readiness.helper === "authenticated" &&
  readiness.capture === "ready" &&
  readiness.tree === "ready" &&
  readiness.input !== "unavailable" &&
  readiness.blockers.length === 0;

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
  /**
   * What the platform says about the element's state, so a toggle or a disabled control shows
   * in a diff and an action can be read back (D5). Absent fields are unknown, not false.
   * selected: chosen in a list, tab or menu, and on some platforms a checked box. checked: a
   * check box, radio button or switch, mixed for indeterminate. expanded: a disclosure, tree
   * row or combo box that is open; partially expanded counts as open, and an element that
   * cannot expand (a leaf) has no expanded at all.
   */
  state: Schema.optionalKey(
    Schema.Struct({
      enabled: Schema.optionalKey(Schema.Boolean),
      selected: Schema.optionalKey(Schema.Boolean),
      checked: Schema.optionalKey(Schema.Union([Schema.Boolean, Schema.Literal("mixed")])),
      expanded: Schema.optionalKey(Schema.Boolean),
    }),
  ),
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
   * A secure field has focus (D6). Nothing of the window leaves: the observation is full and
   * incomplete with no elements, no focused ref and no screenshot (labels can repeat a field's
   * value), and every ref, point and action is refused with privateMode until it loses focus.
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
  // One code point that is not a control, format, surrogate, private-use or unassigned one.
  Schema.String.check(Schema.isPattern(/^[^\p{C}]$/u)),
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
  /**
   * The screenshot of the observation in result, base64. The frame is the only place its bytes
   * travel; GOAT's MCP layer turns it into a content image block (D3).
   */
  image: Schema.optionalKey(
    Schema.Struct({ mimeType: TrimmedNonEmptyString, data: TrimmedNonEmptyString }),
  ),
});
export type ComputerUseReplyFrame = typeof ComputerUseReplyFrame.Type;

/**
 * Which windows the helper watches for the safety signals, only while an agent session runs
 * (D7). watchId names this watch; every event it raises carries it, so events from an earlier
 * watch in the same helper process never reach the next one.
 *
 * Private mode has a lifecycle the server can rely on, since it pauses agents until it clears.
 * Ordering, so no clearing event is ever dropped:
 * - When a target leaves the watch (its window closes, a new watch drops it, or unwatch) while
 *   active, the helper sends active:false for it under the old watchId, before it answers the
 *   request. The old watch stays in force until that answer.
 * - A new watch's initial state for every target, active or not, goes out after its answer,
 *   under the new watchId.
 * - The client switches to the new watchId when the answer arrives, never when it sends the
 *   request (admitComputerUseEvent takes the watch in force).
 * A helper that exits clears every target of its generation.
 */
export const ComputerUseWatchRequest = Schema.Struct({
  watchId: TrimmedNonEmptyString,
  targets: Schema.Array(ComputerUseWindowTarget).check(Schema.isMinLength(1)),
});
export type ComputerUseWatchRequest = typeof ComputerUseWatchRequest.Type;

/**
 * Where a person's input came from. unknown: the platform saw input but not its device. The
 * desktop-to-server cuaHumanInput report should reuse this schema so every value a helper can
 * send reaches the server.
 */
export const ComputerUseHumanInputSource = Schema.Literals(["keyboard", "pointer", "unknown"]);
export type ComputerUseHumanInputSource = typeof ComputerUseHumanInputSource.Type;

/**
 * Something the helper noticed on its own, sent without a request id. The server maps
 * privateMode to cuaPrivateMode and humanInput to cuaHumanInput. Events carry no content: not
 * what was typed, not what the secure field holds.
 */
export const ComputerUseEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("privateMode"),
    active: Schema.Boolean,
    target: ComputerUseWindowTarget,
  }),
  Schema.Struct({
    type: Schema.Literal("humanInput"),
    source: ComputerUseHumanInputSource,
  }),
]);
export type ComputerUseEvent = typeof ComputerUseEvent.Type;

export const ComputerUseEventFrame = Schema.Struct({
  generation: TrimmedNonEmptyString,
  watchId: TrimmedNonEmptyString,
  event: ComputerUseEvent,
});
export type ComputerUseEventFrame = typeof ComputerUseEventFrame.Type;

/**
 * Whether an event may reach the caller. An event from another helper generation, from a watch
 * that has ended, or over the agreed frame limit is quarantined, like a late reply.
 */
export function admitComputerUseEvent(input: {
  readonly frame: ComputerUseEventFrame;
  readonly frameBytes: number;
  readonly maxFrameBytes: number;
  readonly generation: string;
  /** The watch in force, or undefined when nothing is watched. */
  readonly watchId: string | undefined;
}): "deliver" | "wrongGeneration" | "notWatching" | "frameTooLarge" {
  if (input.frameBytes > Math.min(input.maxFrameBytes, COMPUTER_USE_MAX_FRAME_BYTES))
    return "frameTooLarge";
  if (input.frame.generation !== input.generation) return "wrongGeneration";
  return input.frame.watchId === input.watchId ? "deliver" : "notWatching";
}

const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/u;

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (binary: string, start: number, end: number) => {
  let c = 0xffffffff;
  for (let index = start; index < end; index++)
    c = (CRC_TABLE[(c ^ binary.charCodeAt(index)) & 0xff] ?? 0) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
/** Bit depths each PNG color type allows. */
const PNG_DEPTHS: Readonly<Record<number, ReadonlyArray<number>>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};

/**
 * The format and size an image's own bytes declare: a PNG's complete IHDR chunk (length, depth
 * and color type, CRC), or a JPEG's start-of-frame segment reached through well-formed segments
 * before any scan. Undefined for anything else or anything malformed.
 */
export function computerUseImageInfo(data: string):
  | {
      readonly mimeType: "image/png" | "image/jpeg";
      readonly width: number;
      readonly height: number;
    }
  | undefined {
  if (data.length % 4 !== 0 || data.length > COMPUTER_USE_MAX_FRAME_BYTES || !BASE64.test(data))
    return undefined;
  const binary = atob(data);
  const byte = (index: number) => binary.charCodeAt(index);
  const word = (index: number) => (byte(index) << 8) | byte(index + 1);
  const long = (index: number) => word(index) * 0x10000 + word(index + 2);

  if (binary.startsWith("\x89PNG\r\n\x1a\n")) {
    // Signature (8), length (4), "IHDR" (4), 13 bytes of data, CRC (4).
    if (binary.length < 33 || long(8) !== 13 || binary.slice(12, 16) !== "IHDR") return undefined;
    const width = long(16);
    const height = long(20);
    const depths = PNG_DEPTHS[byte(25)];
    // Compression and filter method 0 are the only ones PNG defines; interlace is 0 or 1.
    const methods = byte(26) === 0 && byte(27) === 0 && (byte(28) === 0 || byte(28) === 1);
    if (!depths?.includes(byte(24)) || !methods || long(29) !== crc32(binary, 12, 29))
      return undefined;
    return width > 0 && height > 0 && width < 2 ** 31 && height < 2 ** 31
      ? { mimeType: "image/png", width, height }
      : undefined;
  }

  if (byte(0) !== 0xff || byte(1) !== 0xd8) return undefined;
  let index = 2;
  while (index + 1 < binary.length) {
    if (byte(index) !== 0xff) return undefined;
    const marker = byte(index + 1);
    if (marker === 0xff) {
      index += 1; // fill byte
      continue;
    }
    // Restart markers and TEM carry no length; a second SOI, EOI or a scan before any frame is
    // not a readable image.
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      index += 2;
      continue;
    }
    if (marker === 0xd8 || marker === 0xd9 || marker === 0xda) return undefined;
    if (index + 3 >= binary.length) return undefined;
    const length = word(index + 2);
    if (length < 2 || index + 2 + length > binary.length) return undefined;
    // Start of frame, except DHT (C4), JPG (C8) and DAC (CC).
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      // Precision, height, width, component count and at least one component.
      if (length < 11) return undefined;
      const components = byte(index + 9);
      if (length !== 8 + 3 * components || ![1, 3, 4].includes(components)) return undefined;
      const height = word(index + 5);
      const width = word(index + 7);
      return width > 0 && height > 0 ? { mimeType: "image/jpeg", width, height } : undefined;
    }
    index += 2 + length;
  }
  return undefined;
}

/**
 * Why a reply's image cannot be shown with its observation, or undefined when it can. An image
 * belongs only with an observation that declares a screenshot, and its own bytes must be that
 * format and exactly that size: points the agent picks are pixels of the declared screenshot.
 * Never beside a private observation. The frame's total size is checked by
 * admitComputerUseReply. For an action result, pass the observation inside it.
 */
export function computerUseReplyImageProblem(
  observation: ComputerUseObservation | undefined,
  image: ComputerUseReplyFrame["image"],
): string | undefined {
  if (observation?.privateMode && image) return "A private observation carried an image.";
  if (!image) return undefined;
  const declared = observation?.screenshot;
  if (!declared) return "An image came without an observation that declares one.";
  const actual = computerUseImageInfo(image.data);
  if (!actual) return "The image is not a readable PNG or JPEG.";
  if (actual.mimeType !== image.mimeType || actual.mimeType !== declared.mimeType)
    return (
      "The image is " +
      actual.mimeType +
      "; the frame says " +
      image.mimeType +
      " and the observation " +
      declared.mimeType +
      "."
    );
  if (actual.width !== declared.width || actual.height !== declared.height)
    return (
      "The image is " +
      actual.width +
      "x" +
      actual.height +
      "; the observation declares " +
      declared.width +
      "x" +
      declared.height +
      "."
    );
  return undefined;
}

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
