import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const HubParityCheckId = Schema.Literals(["P1", "P2", "P3", "P4", "P5", "P6", "P7", "P8"]);
export type HubParityCheckId = typeof HubParityCheckId.Type;

export const HubParityResult = Schema.Struct({
  verdict: Schema.Literals(["ok", "degraded", "broken", "unproven"]),
  checkedAt: Schema.Number,
  failingCheckIds: Schema.Array(HubParityCheckId),
  checks: Schema.Array(
    Schema.Struct({
      id: HubParityCheckId,
      status: Schema.Literals(["ok", "failed", "unproven", "skipped"]),
      reason: Schema.String,
    }),
  ),
});
export type HubParityResult = typeof HubParityResult.Type;

/** Bounded, credential-free evidence. Absence means not observed, never success. */
export const HubParityEvidence = Schema.Struct({
  observedAt: Schema.Number,
  healthRole: Schema.optional(Schema.String),
  instanceId: Schema.optional(Schema.String),
  startedAt: Schema.optional(Schema.Number),
  childLinkId: Schema.optional(Schema.String),
  settingsLinkId: Schema.optional(Schema.String),
  settingsDigest: Schema.optional(Schema.String),
  appliedSettingsDigest: Schema.optional(Schema.String),
  modelsStatus: Schema.optional(Schema.Int),
  catalogDigest: Schema.optional(Schema.String),
  servedBy: Schema.optional(Schema.String),
  wiring: Schema.optional(
    Schema.Array(
      Schema.Struct({
        status: Schema.Literals(["ok", "failed", "unproven"]),
        reason: Schema.String,
      }),
    ),
  ),
  localProviderCount: Schema.optional(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});
export type HubParityEvidence = typeof HubParityEvidence.Type;

export const GoatHubDeviceVerifyInput = Schema.Struct({
  deviceAlias: TrimmedNonEmptyString.check(Schema.isMaxLength(255)),
});
export const GoatHubDeviceVerifyResult = Schema.Struct({
  deviceAlias: TrimmedNonEmptyString,
  parity: HubParityResult,
});
