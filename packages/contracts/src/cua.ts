import * as Schema from "effect/Schema";

import { ForwardCompatibleOptional, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { needsHumanFields } from "./humanStepResult.ts";

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
 * What the computer use lease proxy hears from its own server about the lease it was started
 * for, one JSON object per line. Anything other than "active" for that handoff ends it.
 */
export const ComputerUseLeaseUpdate = Schema.Union([
  Schema.Struct({
    state: Schema.Literal("active"),
    handoffId: TrimmedNonEmptyString,
    expiresAt: Schema.String,
  }),
  Schema.Struct({
    state: Schema.Literal("ended"),
    reason: Schema.Literals(["expired", "revoked", "replaced", "disabled", "unauthorized"]),
  }),
]);
export type ComputerUseLeaseUpdate = typeof ComputerUseLeaseUpdate.Type;

/** Path the proxy reads lease updates from, on the server that issued its MCP credential. */
export const COMPUTER_USE_LEASE_ROUTE = "/api/computer-use/lease";

export const ComputerUseRequestInput = Schema.Struct({
  purpose: TrimmedNonEmptyString.check(Schema.isMaxLength(500)).annotate({
    description:
      "What you will do on the screen and why, in one or two sentences. The person sees it before approving.",
  }),
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
    reason: Schema.Literals(["disabled", "unsupported", "held", "not_unattended"]),
    holderThreadId: Schema.optionalKey(ThreadId),
    message: Schema.String,
  }),
]);
export type ComputerUseRequestResult = typeof ComputerUseRequestResult.Type;

/**
 * Providers whose agent process runs on this host and can spawn the driver's
 * stdio MCP server. Cloud providers run elsewhere, and the driver would
 * operate this host's desktop on their behalf; Muse only accepts HTTP session
 * servers. See ADR-0020 for the per-adapter table. Clients read it to say why
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
