import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

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

/** Driver readiness on one host, independent of the enableCua setting. */
export const CuaHostStatus = Schema.Struct({
  platform: Schema.Literals(["darwin", "linux", "win32", "other"]),
  running: Schema.Boolean,
  /** Why the last start failed, until a later start succeeds. */
  failure: Schema.optionalKey(Schema.String),
  /** Linux hosts in a Wayland session, where the driver supports fewer apps than on X11. */
  wayland: Schema.optionalKey(Schema.Boolean),
});
export type CuaHostStatus = typeof CuaHostStatus.Type;

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
