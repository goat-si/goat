import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HubParityResult } from "./hubParity.ts";

/**
 * How a device reaches the hub. Remote Link refuses Windows, and a device GOAT reaches only by
 * password cannot host the Home's SSH tunnel, so those join as Hub-mode clients (design §1.5).
 */
export const HubDeviceTransport = Schema.Literals(["remote-link", "hub-client"]);
export type HubDeviceTransport = typeof HubDeviceTransport.Type;

export const HubDeviceOperationInput = Schema.Struct({
  deviceAlias: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  /** An answered decision from an earlier call; it is consumed once. */
  decisionId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
  /** Join only; omitted means hub-client on Windows and remote-link elsewhere. */
  transport: Schema.optional(HubDeviceTransport),
});
export type HubDeviceOperationInput = typeof HubDeviceOperationInput.Type;

export const HubDeviceStep = Schema.Struct({
  step: Schema.Literals([
    "preflight",
    "probe",
    "link_add",
    "invite",
    "connect",
    "sync",
    "restart",
    "reconnect",
    "revoke",
    "disconnect",
    "health",
    "link_removed",
  ]),
  outcome: Schema.Literals(["ok", "failed", "deferred"]),
  detail: Schema.optional(Schema.String),
});
export type HubDeviceStep = typeof HubDeviceStep.Type;

export const HubDeviceOperationResult = Schema.Struct({
  deviceAlias: TrimmedNonEmptyString,
  action: Schema.Literals(["join", "leave", "repair"]),
  /** child: joined and verified; ready: standalone again; needs_human: answer decisionId, then call again. */
  state: Schema.Literals(["child", "ready", "degraded", "needs_human", "failed"]),
  transport: Schema.optional(HubDeviceTransport),
  message: Schema.String,
  steps: Schema.Array(HubDeviceStep),
  parity: Schema.optional(HubParityResult),
  decisionId: Schema.optional(Schema.String),
});
export type HubDeviceOperationResult = typeof HubDeviceOperationResult.Type;
