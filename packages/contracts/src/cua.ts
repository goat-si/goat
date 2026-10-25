import * as Schema from "effect/Schema";
import * as SchemaAST from "effect/SchemaAST";
import * as SchemaParser from "effect/SchemaParser";
import * as SchemaTransformation from "effect/SchemaTransformation";

import {
  ForwardCompatibleOptional,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
} from "./baseSchemas.ts";
import {
  ComputerUseCapabilities,
  ComputerUseHumanInputSource,
  ComputerUseReadiness,
  type ComputerUseRefusalReason,
} from "./computerUseProtocol.ts";
import { needsHumanFields } from "./humanStepResult.ts";
import { PreviewSessionNoPicture } from "./previewSession.ts";

/** Native host descriptor, confined to the desktop/server control pipe. */
export const CuaDriverMcpConfiguration = Schema.Struct({
  command: TrimmedNonEmptyString,
  args: Schema.Array(Schema.String),
  environment: Schema.Array(Schema.Struct({ name: TrimmedNonEmptyString, value: Schema.String })),
  socketPath: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CuaDriverMcpConfiguration = typeof CuaDriverMcpConfiguration.Type;

export const DesktopCuaDriverRequest = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("cuaDriverRequest"),
  requestId: TrimmedNonEmptyString,
  enabled: Schema.Boolean,
});
export type DesktopCuaDriverRequest = typeof DesktopCuaDriverRequest.Type;

export const DesktopCuaAppsRequest = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("cuaAppsRequest"),
  requestId: TrimmedNonEmptyString,
});
export type DesktopCuaAppsRequest = typeof DesktopCuaAppsRequest.Type;

export const DesktopCuaAppsReport = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("cuaApps"),
    requestId: TrimmedNonEmptyString,
    status: Schema.Literal("listed"),
    apps: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(1000)),
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("cuaApps"),
    requestId: TrimmedNonEmptyString,
    status: Schema.Literal("unavailable"),
  }),
]);
export type DesktopCuaAppsReport = typeof DesktopCuaAppsReport.Type;

/**
 * Whether any agent controls this host right now; the desktop's helper watches for secret
 * fields and a person's input only while it does (D7, #1235). seq grows with every change the
 * server sends, so the desktop drops one that arrives after a newer one; the server sends the
 * current value again whenever the desktop reconnects.
 */
export const DesktopCuaWatch = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("cuaWatch"),
  seq: Schema.Int,
  active: Schema.Boolean,
  /**
   * Union of approved app ids across live controls that name apps (bundle ids or Windows
   * executable paths). Whole-screen controls contribute none. Optional for older desktops;
   * new desktops refresh their driver manifest when an approved app was started later.
   */
  apps: Schema.optional(Schema.Array(Schema.String)),
});
export type DesktopCuaWatch = typeof DesktopCuaWatch.Type;

/**
 * Server -> desktop: the windows whose live picture viewers want now (#1370), keyed by preview
 * session. Only windows of an active agent control, named by the agent's own calls, ever appear;
 * an empty list stops every capture. seq grows with every change, and a frame answers the seq it
 * was captured for, so the server drops any frame from before a stop or a change of window.
 * apps is the control's approved bundle ids (absent for the whole screen): the helper captures
 * only a window whose owning app is one of them, and answers appNotApproved otherwise.
 */
export const DesktopCuaFrames = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("cuaFrames"),
  seq: Schema.Int,
  targets: Schema.Array(
    Schema.Struct({
      key: TrimmedNonEmptyString,
      pid: Schema.Int,
      windowId: Schema.Int,
      apps: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
      maxWidth: Schema.Int,
      intervalMs: Schema.Int,
    }),
  ),
});
export type DesktopCuaFrames = typeof DesktopCuaFrames.Type;

/** Desktop -> server: one JPEG of a requested window, or why there is none. */
export const DesktopCuaFrame = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("cuaFrame"),
    seq: Schema.Int,
    key: TrimmedNonEmptyString,
    width: Schema.Int,
    height: Schema.Int,
    mime: Schema.Literal("image/jpeg"),
    data: Schema.String,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("cuaFrameUnavailable"),
    seq: Schema.Int,
    key: TrimmedNonEmptyString,
    reason: PreviewSessionNoPicture,
  }),
]);
export type DesktopCuaFrame = typeof DesktopCuaFrame.Type;

/**
 * Proxy -> server, on its own lease route: the window an agent's admitted call just named. The
 * proxy forwards only calls inside the control's approved apps, so a reported window is one the
 * agent may act on.
 */
export const ComputerUseLeaseTarget = Schema.Struct({
  controlId: TrimmedNonEmptyString,
  pid: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  windowId: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});
export type ComputerUseLeaseTarget = typeof ComputerUseLeaseTarget.Type;

/** Milliseconds since the Unix epoch on the host's clock, which the proxy and server share. */
const EpochMillis = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Proxy -> server, on the same route: keyboard or pointer events the lease proxy's helper saw
 * while the control was live (#1235), one or every event that piled up behind the last report
 * (#1488), in time order. The server judges each: an event another agent's input covers is
 * dropped, and the first one no agent covers pauses every agent. Only the kind of input and when,
 * never what was typed or where.
 */
const ComputerUseHumanInputEvent = Schema.Struct({
  source: ComputerUseHumanInputSource,
  at: EpochMillis,
});
/**
 * The most events one report carries; a proxy sends any more in the next one. Large enough that
 * a 1 kHz pointer behind a report as slow as the proxy's 2 s timeout fits in one.
 */
export const COMPUTER_USE_HUMAN_INPUT_BATCH = 4096;
export const ComputerUseLeaseHumanInput = Schema.Struct({
  controlId: TrimmedNonEmptyString,
  // One event is what a proxy from before batching sends.
  humanInput: Schema.Union([
    ComputerUseHumanInputEvent,
    Schema.Array(ComputerUseHumanInputEvent).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(COMPUTER_USE_HUMAN_INPUT_BATCH),
    ),
  ]),
});
export type ComputerUseLeaseHumanInput = typeof ComputerUseLeaseHumanInput.Type;

/**
 * Proxy -> server: one of the proxy's calls that can post input started or ended at `at`, so a
 * person's input reported by any agent's helper can be told apart from every agent's own.
 */
export const ComputerUseLeaseAgentInput = Schema.Struct({
  controlId: TrimmedNonEmptyString,
  agentInput: Schema.Struct({
    call: TrimmedNonEmptyString,
    state: Schema.Literals(["start", "end"]),
    at: EpochMillis,
    /**
     * The kinds of event a starting call can post. Only an event of a kind listed here is taken
     * for the agent's own; a start without it covers both, as an older proxy's did.
     */
    kinds: Schema.optionalKey(Schema.Array(Schema.Literals(["keyboard", "pointer"]))),
  }),
});
export type ComputerUseLeaseAgentInput = typeof ComputerUseLeaseAgentInput.Type;

export const ComputerUseLeaseReport = Schema.Union([
  ComputerUseLeaseTarget,
  ComputerUseLeaseHumanInput,
  ComputerUseLeaseAgentInput,
]);
export type ComputerUseLeaseReport = typeof ComputerUseLeaseReport.Type;

/**
 * Why the desktop would not give agents a driver, in a form every surface can act on: the
 * preview tile, Settings and onboarding, the agent's own computer_use request, and the trace
 * (#1399). A grant macOS has not given (permissionsNotGranted), or a Windows desktop the helper
 * cannot use (desktopUnavailable, #1516); other refusals keep their message.
 */
export const CuaAgentPermissionsBlock = Schema.Struct({
  reason: Schema.Literal("permissionsNotGranted"),
  /** The grants macOS has not given the app that holds them, GOAT Computer Use or GOAT. */
  missing: Schema.Array(Schema.Literals(["accessibility", "screenRecording"])).check(
    Schema.isMinLength(1),
  ),
  holder: Schema.Literals(["helper", "app"]),
});
export type CuaAgentPermissionsBlock = typeof CuaAgentPermissionsBlock.Type;

/**
 * The Windows helper cannot use this desktop: no interactive desktop (a service, SSH or Session
 * 0), the lock screen or a security prompt (UAC) holding input, another user at the console, or
 * the helper itself not starting or answering (no blocker). detail is the helper's own sentence.
 */
export const CuaAgentDesktopBlock = Schema.Struct({
  reason: Schema.Literal("desktopUnavailable"),
  blocker: Schema.optionalKey(
    Schema.Literals(["noInteractiveDesktop", "screenLocked", "otherUserAtConsole"]),
  ),
  detail: TrimmedNonEmptyString,
});
export type CuaAgentDesktopBlock = typeof CuaAgentDesktopBlock.Type;

export const CuaAgentBlock = Schema.Union([CuaAgentPermissionsBlock, CuaAgentDesktopBlock]);
export type CuaAgentBlock = typeof CuaAgentBlock.Type;

/** The System Settings lists a block names, as macOS titles them. */
export const cuaAgentBlockLists = (block: CuaAgentPermissionsBlock): string =>
  block.missing
    .map((grant) =>
      grant === "accessibility" ? "Accessibility" : "Screen & System Audio Recording",
    )
    .join(" and ");

/** A Windows desktop block's short title, by its cause; the helper's detail says the rest. */
const desktopTitle = {
  noInteractiveDesktop: "Start GOAT from the signed-in Windows desktop",
  screenLocked: "Unlock the screen or answer the Windows security prompt",
  otherUserAtConsole: "Another user is signed in at this computer's screen",
} as const;

/** A short title for a block, such as a session card's: what is missing, not the whole sentence. */
export const cuaAgentBlockTitle = (block: CuaAgentBlock): string =>
  block.reason === "permissionsNotGranted"
    ? `Allow ${block.holder === "helper" ? "GOAT Computer Use" : "GOAT"} in ${cuaAgentBlockLists(block)}`
    : block.blocker === undefined
      ? "GOAT Computer Use cannot use this desktop"
      : desktopTitle[block.blocker];

/** The sentence every surface shows for a block. */
export const cuaAgentBlockMessage = (block: CuaAgentBlock): string =>
  block.reason === "permissionsNotGranted"
    ? `Computer use cannot start: macOS has not allowed ${block.holder === "helper" ? "GOAT Computer Use" : "GOAT"} in ${cuaAgentBlockLists(block)}. A person turns it on in System Settings > Privacy & Security.`
    : `Computer use cannot start: ${block.detail}`;

/**
 * What of a block newer readiness still bears out: only the grants it does not report granted,
 * and nothing once every one is back, so no surface keeps naming a grant the person gave.
 * Readiness is the helper's, so it only speaks for a block the helper holds; a block on GOAT
 * itself stays as it was. A Windows desktop block ends once the helper reports an authenticated
 * helper with nothing blocking.
 */
export const cuaAgentBlockUnder = (
  block: CuaAgentBlock,
  readiness: typeof ComputerUseReadiness.Type,
): CuaAgentBlock | undefined => {
  if (block.reason === "desktopUnavailable")
    return readiness.helper === "authenticated" && readiness.blockers.length === 0
      ? undefined
      : block;
  if (block.holder !== "helper") return block;
  const missing = block.missing.filter(
    (grant) =>
      readiness.grants[grant === "accessibility" ? "accessibility" : "screenCapture"] !== "granted",
  );
  if (missing.length === block.missing.length) return block;
  return missing.length === 0 ? undefined : { ...block, missing };
};

export const DesktopCuaDriverReport = Schema.Union([
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("cuaDriverReport"),
    requestId: TrimmedNonEmptyString,
    status: Schema.Literal("ready"),
    mcp: CuaDriverMcpConfiguration,
  }),
  Schema.Struct({
    version: Schema.Literal(1),
    type: Schema.Literal("cuaDriverReport"),
    requestId: TrimmedNonEmptyString,
    status: Schema.Literals(["stopped", "unavailable"]),
    message: Schema.optionalKey(Schema.String),
    /** Set when the reason is one of the typed ones; older desktops send only the message. */
    block: ForwardCompatibleOptional(CuaAgentBlock),
  }),
]);
export type DesktopCuaDriverReport = typeof DesktopCuaDriverReport.Type;

/**
 * Whether this host has a screen the driver can use. available: full computer use. partial:
 * the driver runs with fewer abilities, such as screenshots and pixel input without an
 * accessibility tree. unavailable: the driver cannot run here, and computer use cannot be
 * turned on. A later level a client does not know decodes away, so never treat a missing
 * value as unavailable.
 */
export const CuaDisplayCapabilityLevel = Schema.Literals(["available", "partial", "unavailable"]);
export type CuaDisplayCapabilityLevel = typeof CuaDisplayCapabilityLevel.Type;

export const CuaDisplayCapability = Schema.Struct({
  capability: CuaDisplayCapabilityLevel,
  /** Written for the person deciding whether to turn computer use on. */
  reason: Schema.String,
  /** The screen the driver uses: an X display such as `:1`, `console` on macOS, or a Windows session. */
  display: Schema.optionalKey(TrimmedNonEmptyString),
});
export type CuaDisplayCapability = typeof CuaDisplayCapability.Type;

export const CuaToolsAvailability = Schema.Literals(["available", "off", "unavailable"]);
export type CuaToolsAvailability = typeof CuaToolsAvailability.Type;

/** Driver readiness on one host, independent of the enableCua setting. */
export const CuaHostStatus = Schema.Struct({
  platform: Schema.Literals(["darwin", "linux", "win32", "other"]),
  running: Schema.Boolean,
  /** Why the last start failed, until a later start succeeds. */
  failure: Schema.optionalKey(Schema.String),
  /** The typed reason behind that failure, when it is one agents cannot get past alone. */
  block: ForwardCompatibleOptional(CuaAgentBlock),
  /** Linux hosts in a Wayland session, where the driver supports fewer apps than on X11. */
  wayland: Schema.optionalKey(Schema.Boolean),
  /** Older hosts omit it; they predate the check, so clients fall back to the platform. */
  display: ForwardCompatibleOptional(CuaDisplayCapability),
  /**
   * Each readiness step of the host's computer use helper, as it last reported them. Older
   * hosts and hosts whose helper has not answered yet omit it: not known, never "ready".
   */
  readiness: ForwardCompatibleOptional(ComputerUseReadiness),
  /** Which safety signals that helper raises; absent means neither (#1235). */
  signals: ForwardCompatibleOptional(ComputerUseCapabilities.fields.signals),
  /** Decided by the server's setting and running driver, never by the helper. */
  tools: ForwardCompatibleOptional(CuaToolsAvailability),
});
export type CuaHostStatus = typeof CuaHostStatus.Type;

/** Computer use on one host, for host status and the provider × host matrix. */
export const HostComputerUse = Schema.Struct({
  enabled: Schema.Boolean,
  running: Schema.Boolean,
  ...CuaDisplayCapability.fields,
});
export type HostComputerUse = typeof HostComputerUse.Type;

/**
 * Driver-side proof of the macOS grants, in the order the desktop runs them. Steps after the
 * first failure are not run, so their absence means "not checked".
 */
export const CuaVerificationStepId = Schema.Literals([
  "grants",
  "restart",
  "permissions",
  "identity",
  "capture",
  "accessibility",
]);
export type CuaVerificationStepId = typeof CuaVerificationStepId.Type;

export const CuaVerificationStep = Schema.Struct({
  id: CuaVerificationStepId,
  ok: Schema.Boolean,
  detail: Schema.optionalKey(Schema.String),
});
export type CuaVerificationStep = typeof CuaVerificationStep.Type;

export const DesktopCuaVerification = Schema.Struct({
  verified: Schema.Boolean,
  steps: Schema.Array(CuaVerificationStep),
});
export type DesktopCuaVerification = typeof DesktopCuaVerification.Type;

/**
 * The macOS grants of whichever app computer use runs as. helper: GOAT Computer Use.app, read
 * from a fresh helper process; app: GOAT itself, for builds without the helper; unusable: the
 * helper ships and cannot run, so no other app may stand in for it.
 */
export const DesktopCuaGrants = Schema.Union([
  Schema.Struct({
    principal: Schema.Literals(["helper", "app"]),
    /** The name the app has in System Settings' lists. */
    name: Schema.String,
    /** Where the app that needs the grants lives, so the person can tell it from older copies. */
    bundlePath: Schema.optionalKey(Schema.String),
    bundleId: Schema.String,
    accessibility: Schema.Boolean,
    screenRecording: Schema.Boolean,
  }),
  Schema.Struct({ principal: Schema.Literal("unusable"), message: Schema.String }),
]);
export type DesktopCuaGrants = typeof DesktopCuaGrants.Type;

/**
 * Why a computer use control stopped. stopped: a person pressed Stop on the thread's turn.
 * stopped_all: a person used the kill switch for every thread on the host.
 */
export const ComputerUseControlEnd = Schema.Literals([
  "expired",
  "revoked",
  "replaced",
  "disabled",
  "unauthorized",
  "stopped",
  "stopped_all",
]);
export type ComputerUseControlEnd = typeof ComputerUseControlEnd.Type;

/**
 * Why the agent waits: a person's own input reached the shared desktop, they took over, or a
 * secret field has focus (private) until it loses it.
 */
export const ComputerUsePauseReason = Schema.Literals(["human_input", "takeover", "private"]);
export type ComputerUsePauseReason = typeof ComputerUsePauseReason.Type;

export const ComputerUseForegroundGrant = Schema.Struct({
  handoffId: TurnItemId,
  purpose: TrimmedNonEmptyString,
  target: Schema.Literal("desktop"),
  expiresAtMillis: Schema.Int.check(
    Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
  ),
});
export type ComputerUseForegroundGrant = typeof ComputerUseForegroundGrant.Type;

/**
 * What the computer use proxy hears from its own server about the control it was started for,
 * one JSON object per line. "active" carries the apps the thread may control, absent when every
 * app the driver admits is allowed; "paused" holds every call until a later "active"; anything
 * else for that control ends it.
 */
export const ComputerUseLeaseUpdate = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("active"),
    controlId: TrimmedNonEmptyString,
    expiresAt: Schema.String,
    apps: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
    foreground: Schema.optionalKey(Schema.Array(ComputerUseForegroundGrant)),
    /** Calls echo this value so a missed idle/reuse update cannot admit old-turn input. */
    idleEpoch: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
    /**
     * How many times the host has paused agents, and why last. A pause and its end can both
     * land before the proxy reads the control, so a higher count still ends the call in flight.
     */
    interruptions: Schema.optionalKey(
      Schema.Struct({ count: Schema.Int, last: ComputerUsePauseReason }),
    ),
    /**
     * Another thread holds a grant on this screen, so calls that bring a window forward or move
     * the pointer would take it from that thread.
     */
    shared: Schema.optionalKey(Schema.Literal(true)),
  }),
  Schema.Struct({
    state: Schema.Literal("paused"),
    controlId: TrimmedNonEmptyString,
    expiresAt: Schema.optionalKey(Schema.String),
    reason: ComputerUsePauseReason,
  }),
  Schema.Struct({
    state: Schema.Literal("idle"),
    controlId: TrimmedNonEmptyString,
    expiresAt: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({ state: Schema.Literal("ended"), reason: ComputerUseControlEnd }),
]);
export type ComputerUseLeaseUpdate = typeof ComputerUseLeaseUpdate.Type;

/** Thread subscriptions stay open between controls; only `ended` or EOF ends the subscription. */
export const ComputerUseLeaseThreadUpdate = Schema.Union([
  ComputerUseLeaseUpdate.members[0],
  Schema.Struct({
    state: Schema.Literal("paused"),
    controlId: TrimmedNonEmptyString,
    expiresAt: Schema.String,
    reason: ComputerUsePauseReason,
  }),
  Schema.Struct({
    state: Schema.Literal("idle"),
    controlId: TrimmedNonEmptyString,
    expiresAt: Schema.String,
  }),
  ComputerUseLeaseUpdate.members[3],
  Schema.Struct({ state: Schema.Literal("waiting") }),
  Schema.Struct({
    state: Schema.Literal("control-ended"),
    controlId: TrimmedNonEmptyString,
    reason: ComputerUseControlEnd,
  }),
]);
export type ComputerUseLeaseThreadUpdate = typeof ComputerUseLeaseThreadUpdate.Type;

/**
 * The proxy's finer account of a refusal, beside its shared reason (ComputerUseRefusalReason in
 * computerUseProtocol.ts). A policy refusal is targetRefused, never a person's stop (#1146).
 */
export const ComputerUseRefusalDetail = Schema.Literals([
  "target_busy",
  "invalid_target",
  "control_idle",
  "app_not_approved",
  "desktop_not_approved",
  "foreground_not_approved",
  /** Whole-display screenshots are off; an agent looks at one window at a time (#1321). */
  "desktop_capture_off",
  "waiting_for_human",
  "private_mode",
  ...ComputerUseControlEnd.literals,
  "lost",
  /** The driver went away under the proxy: GOAT Computer Use stopped, crashed or was updated. */
  "helper_restarted",
  /**
   * GOAT Computer Use refused the process that started it (its parent check, exit 77), so no
   * connection from this GOAT can work until GOAT or the helper is fixed; a restart does not help.
   */
  "helper_refused",
  /** The driver named a window that is not on the screen GOAT gave it (#1358). */
  "wrong_display",
  /** It would bring a window forward or move the pointer while another thread holds apps here. */
  "screen_shared",
]);
export type ComputerUseRefusalDetail = typeof ComputerUseRefusalDetail.Type;

export const computerUseRefusalReason = (
  detail: ComputerUseRefusalDetail,
): ComputerUseRefusalReason => {
  switch (detail) {
    case "stopped":
    case "stopped_all":
      return "userStoppedSession";
    case "waiting_for_human":
      return "userIntervened";
    case "app_not_approved":
      return "appNotAllowed";
    case "helper_restarted":
    case "helper_refused":
      return "helperUnavailable";
    default:
      return "targetRefused";
  }
};

/** Path the proxy reads control updates from, on the server that issued its MCP credential. */
export const COMPUTER_USE_LEASE_ROUTE = "/api/computer-use/lease";

const ComputerUseCallOwner = {
  controlId: TrimmedNonEmptyString,
  connectionId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
};

// Validation carries only ticket identity; replacement call authority is never accepted.
const ticketValidation = Schema.Struct({
  ...ComputerUseCallOwner,
  action: Schema.Literal("validate"),
  reservationId: TrimmedNonEmptyString,
});
const strictTicketValidation = Schema.declareConstructor<
  typeof ticketValidation.Type,
  typeof ticketValidation.Encoded
>()(
  [ticketValidation],
  ([codec]) => {
    const decode = SchemaParser.decodeUnknownEffect(codec);
    return (input, _ast, options) => decode(input, { ...options, onExcessProperty: "error" });
  },
  {
    toCodec: ([codec]) => new SchemaAST.Link(codec.ast, SchemaTransformation.passthrough()),
    toCodecJson: () => undefined,
  },
);

/** A proxy reserves execution before dispatch, and closes a driver generation after cutoff. */
export const ComputerUseCallReservation = Schema.Union([
  Schema.Struct({
    ...ComputerUseCallOwner,
    action: Schema.Literal("reserve"),
    callId: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    interruptions: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    idleEpoch: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    name: TrimmedNonEmptyString.check(Schema.isMaxLength(200)),
    args: Schema.Unknown,
    foregroundGrantId: Schema.optionalKey(TurnItemId),
  }),
  strictTicketValidation,
  Schema.Struct({
    ...ComputerUseCallOwner,
    action: Schema.Literal("release"),
    reservationId: TrimmedNonEmptyString,
  }),
  Schema.Struct({ ...ComputerUseCallOwner, action: Schema.Literal("close") }),
]);
export type ComputerUseCallReservation = typeof ComputerUseCallReservation.Type;

export const ComputerUseCallAdmission = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("admitted"),
    reservationId: Schema.NullOr(Schema.String),
    /** Scope at atomic admission; streamed updates may still be in transit. */
    permissions: Schema.optionalKey(
      Schema.Struct({
        apps: Schema.optionalKey(Schema.Array(TrimmedNonEmptyString)),
        validUntilMillis: Schema.Int.check(
          Schema.isGreaterThanOrEqualTo(0),
          Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
        ),
      }),
    ),
  }),
  Schema.Struct({ status: Schema.Literal("released") }),
  Schema.Struct({
    status: Schema.Literal("refused"),
    detail: ComputerUseRefusalDetail,
    holderThreadId: Schema.optionalKey(ThreadId),
  }),
]);
export type ComputerUseCallAdmission = typeof ComputerUseCallAdmission.Type;

/**
 * Sent by the desktop host's computer use helper when a person's own keyboard or pointer input
 * reaches the desktop while an agent controls it. The server pauses every agent on the host
 * until a person hands control back.
 */
export const DesktopCuaHumanInputReport = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("cuaHumanInput"),
  /** The same sources the helper's own humanInput event carries (computerUseProtocol.ts). */
  source: ComputerUseHumanInputSource,
});
export type DesktopCuaHumanInputReport = typeof DesktopCuaHumanInputReport.Type;

/**
 * Sent by the desktop host when a secure text field or passkey prompt gains or loses focus, in
 * the window it names; never what the field holds. While active, agents on the host neither
 * observe nor act. The helper's own event frame is in computerUseProtocol.ts.
 */
export const DesktopCuaPrivateModeReport = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("cuaPrivateMode"),
  active: Schema.Boolean,
  target: Schema.Struct({ pid: Schema.Int, windowId: Schema.Int }),
});
export type DesktopCuaPrivateModeReport = typeof DesktopCuaPrivateModeReport.Type;

/**
 * The desktop host's computer use helper: each readiness step and which safety signals it
 * raises, sent when either changes and again for every helper launch. generation counts the
 * desktop's helper launches, so a report from an earlier launch that arrives late is dropped.
 * The signals here are the only word on what the host detects: unattended turns run only where
 * both are supported (#1235), and a host that never reports has neither.
 */
export const DesktopCuaReadinessReport = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("cuaReadiness"),
  generation: Schema.Int,
  readiness: ComputerUseReadiness,
  signals: ComputerUseCapabilities.fields.signals,
  /** Whether the helper sends live frames of one window (#1370); absent from older helpers. */
  frames: Schema.optionalKey(Schema.Boolean),
  /**
   * Whether this desktop answers cuaAppsRequest (#1536). Older desktops ignore the request, so
   * the server asks only a desktop that says it answers; absent means it does not (#1567).
   */
  appsListing: Schema.optionalKey(Schema.Boolean),
});
export type DesktopCuaReadinessReport = typeof DesktopCuaReadinessReport.Type;

export type DesktopCuaSafetyReport =
  | DesktopCuaHumanInputReport
  | DesktopCuaPrivateModeReport
  | DesktopCuaReadinessReport;

export const ComputerUseStopInput = Schema.Struct({ threadId: ThreadId });
export const ComputerUseStopResult = Schema.Struct({ stopped: Schema.Boolean });
export const ComputerUseStopAllResult = Schema.Struct({
  /** Threads whose control ended, unattended admissions included. */
  stopped: Schema.Int,
});
/** App ids as the driver lists them: a macOS bundle id, or the app name elsewhere. */
const ComputerUseApps = Schema.Array(TrimmedNonEmptyString.check(Schema.isMaxLength(200))).check(
  Schema.isMaxLength(20),
);

export const ComputerUseRequestInput = Schema.Struct({
  foreground: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Ask to bring apps forward and take keyboard or pointer focus for this purpose. Default false (background-only). Requires whole-desktop approval: omit apps. Pause, Stop or control replacement requires approval again.",
    }),
  ),
  purpose: TrimmedNonEmptyString.check(Schema.isMaxLength(500)).annotate({
    description:
      "What you will do on the screen and why, in one or two sentences. The person sees it before approving.",
  }),
  apps: Schema.optional(
    ComputerUseApps.annotate({
      description:
        "The apps you will control, by the bundle_id list_apps reports (on Windows usually the executable path), or by its listed name when it has no bundle_id; never a window title. If the app is not open, open it first. The person approves exactly these. Omit only when the work needs the whole screen.",
    }),
  ),
  minutes: Schema.optional(
    Schema.Int.check(Schema.isBetween({ minimum: 5, maximum: 120 })).annotate({
      description: "How long the admission lasts after the request. Default 30, at most 120.",
    }),
  ),
});
export type ComputerUseRequestInput = typeof ComputerUseRequestInput.Type;

export const ComputerUseRequestResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("available"),
    message: Schema.String,
  }),
  Schema.Struct({
    ...needsHumanFields("approval", "goat_computer_use_request"),
    /** This call waited its budget for the answer; the request stays open and wakes the thread. */
    waitTimedOut: Schema.optionalKey(Schema.Literal(true)),
    message: Schema.String,
  }),
  Schema.Struct({
    kind: Schema.Literal("refused"),
    reason: Schema.Literals([
      "disabled",
      "unsupported",
      "held",
      "not_unattended",
      /** The host cannot tell when a person types a secret or uses the desktop (#1235). */
      "detection_unsupported",
      /**
       * The host cannot run computer use until a person acts: macOS has not granted what it
       * needs, or the Windows helper cannot use the desktop (block says which).
       */
      "not_granted",
      "unknown_app",
      /** The person declined, or cancelled the request before answering. */
      "declined",
      "cancelled",
      /** The request reached its expiry unanswered. */
      "expired",
      /** A newer, different request from this thread replaced it. */
      "superseded",
      /** Approved, but this turn's computer use ended or paused meanwhile; a later turn has it. */
      "interrupted",
    ]),
    holderThreadId: Schema.optionalKey(ThreadId),
    unknownApps: Schema.optionalKey(Schema.Array(Schema.String)),
    block: Schema.optionalKey(CuaAgentBlock),
    message: Schema.String,
  }),
]);
export type ComputerUseRequestResult = typeof ComputerUseRequestResult.Type;

/**
 * Providers whose agent process runs on this host and can spawn the driver's
 * stdio MCP server. Cloud providers run elsewhere, and the driver would
 * operate this host's desktop on their behalf; Muse only accepts HTTP session
 * servers. See ADR-0022 for the per-adapter table. Clients read it to say why
 * `@computer` cannot run before a turn is sent.
 */
export const COMPUTER_USE_PROVIDER_DRIVERS: ReadonlySet<string> = new Set([
  "claudeAgent",
  "codex",
  "cursor",
  "grok",
  "antigravity",
  "acpRegistry",
  "opencode",
  "pi",
]);
