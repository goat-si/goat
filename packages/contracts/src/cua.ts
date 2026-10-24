import * as Schema from "effect/Schema";

import { ForwardCompatibleOptional, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
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
 * Proxy -> server, on the same route: a keyboard or pointer event at `at` that the lease
 * proxy's helper saw while the control was live, outside the proxy's own input calls (#1235).
 * The server drops it when another agent's input covers `at`, else every agent pauses. Only the
 * kind of input, never what was typed or where.
 */
export const ComputerUseLeaseHumanInput = Schema.Struct({
  controlId: TrimmedNonEmptyString,
  humanInput: Schema.Struct({ source: ComputerUseHumanInputSource, at: EpochMillis }),
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
  }),
});
export type ComputerUseLeaseAgentInput = typeof ComputerUseLeaseAgentInput.Type;

export const ComputerUseLeaseReport = Schema.Union([
  ComputerUseLeaseTarget,
  ComputerUseLeaseHumanInput,
  ComputerUseLeaseAgentInput,
]);
export type ComputerUseLeaseReport = typeof ComputerUseLeaseReport.Type;

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
    /**
     * How many times the host has paused agents, and why last. A pause and its end can both
     * land before the proxy reads the control, so a higher count still ends the call in flight.
     */
    interruptions: Schema.optionalKey(
      Schema.Struct({ count: Schema.Int, last: ComputerUsePauseReason }),
    ),
  }),
  Schema.Struct({
    state: Schema.Literal("paused"),
    controlId: TrimmedNonEmptyString,
    reason: ComputerUsePauseReason,
  }),
  Schema.Struct({ state: Schema.Literal("ended"), reason: ComputerUseControlEnd }),
]);
export type ComputerUseLeaseUpdate = typeof ComputerUseLeaseUpdate.Type;

/**
 * The proxy's finer account of a refusal, beside its shared reason (ComputerUseRefusalReason in
 * computerUseProtocol.ts). A policy refusal is targetRefused, never a person's stop (#1146).
 */
export const ComputerUseRefusalDetail = Schema.Literals([
  "app_not_approved",
  "desktop_not_approved",
  /** Whole-display screenshots are off; an agent looks at one window at a time (#1321). */
  "desktop_capture_off",
  "waiting_for_human",
  "private_mode",
  ...ComputerUseControlEnd.literals,
  "lost",
  /** The driver went away under the proxy: GOAT Computer Use stopped, crashed or was updated. */
  "helper_restarted",
  /** The driver named a window that is not on the screen GOAT gave it (#1358). */
  "wrong_display",
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
      return "helperUnavailable";
    default:
      return "targetRefused";
  }
};

/** Path the proxy reads control updates from, on the server that issued its MCP credential. */
export const COMPUTER_USE_LEASE_ROUTE = "/api/computer-use/lease";

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
  purpose: TrimmedNonEmptyString.check(Schema.isMaxLength(500)).annotate({
    description:
      "What you will do on the screen and why, in one or two sentences. The person sees it before approving.",
  }),
  apps: Schema.optional(
    ComputerUseApps.annotate({
      description:
        "The apps you will control, by the bundle_id list_apps reports (its name where there is none). The person approves exactly these. Omit only when the work needs the whole screen.",
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
    ]),
    holderThreadId: Schema.optionalKey(ThreadId),
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
