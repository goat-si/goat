import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HubParityResult } from "./hubParity.ts";
import { needsHumanFields } from "./humanStepResult.ts";

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

/**
 * A person's standing consent for an SSH host GOAT set up to join this hub's OpenCodex as a Child
 * after each successful setup. Turning it off never removes a link.
 */
export const HubDeviceChildOptIn = Schema.Struct({
  deviceAlias: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  enabled: Schema.Boolean,
});
export type HubDeviceChildOptIn = typeof HubDeviceChildOptIn.Type;

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

const hubNeedsHuman = <const Call extends string>(call: Call) =>
  Schema.Struct({
    ...HubDeviceOperationResult.fields,
    state: Schema.Literal("needs_human"),
    /** The handoff's id: pass it back as decisionId once a person approved it. */
    decisionId: Schema.String,
    ...needsHumanFields("approval", call),
  });
/**
 * What the hub MCP tools return. A thread caller's approval is a handoff, and decisionId is its
 * id; a caller without a thread still gets an inbox decisionId and no handoff.
 */
export const HubDeviceMcpResult = Schema.Union([
  hubNeedsHuman("goat_hub_device_join"),
  hubNeedsHuman("goat_hub_device_leave"),
  hubNeedsHuman("goat_hub_device_repair"),
  HubDeviceOperationResult,
]);
export type HubDeviceMcpResult = typeof HubDeviceMcpResult.Type;
/** One hub tool's result: its needs_human names only that tool as the next call. */
export const hubDeviceToolResult = <const Call extends string>(call: Call) =>
  Schema.Union([hubNeedsHuman(call), HubDeviceOperationResult]);
