import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HubParityResult } from "./hubParity.ts";

export const HubDeviceOperationInput = Schema.Struct({
  deviceAlias: TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
  /** An answered decision from an earlier call; it is consumed once. */
  decisionId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(255))),
});
export type HubDeviceOperationInput = typeof HubDeviceOperationInput.Type;

export const HubDeviceStep = Schema.Struct({
  step: Schema.Literals([
    "probe",
    "link_add",
    "sync",
    "restart",
    "reconnect",
    "revoke",
    "disconnect",
  ]),
  outcome: Schema.Literals(["ok", "failed", "deferred"]),
  detail: Schema.optional(Schema.String),
});
export type HubDeviceStep = typeof HubDeviceStep.Type;

export const HubDeviceOperationResult = Schema.Struct({
  deviceAlias: TrimmedNonEmptyString,
  action: Schema.Literals(["join", "leave", "repair"]),
  /** child: linked and verified; ready: standalone again; needs_human: answer decisionId, then call again. */
  state: Schema.Literals(["child", "ready", "degraded", "needs_human", "failed"]),
  message: Schema.String,
  steps: Schema.Array(HubDeviceStep),
  parity: Schema.optional(HubParityResult),
  decisionId: Schema.optional(Schema.String),
});
export type HubDeviceOperationResult = typeof HubDeviceOperationResult.Type;
