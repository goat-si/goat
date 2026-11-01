import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";
import { HandoffSummary } from "./handoff.ts";
import { ProviderDiagnosisFix } from "./providerDiagnosis.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

export const ProviderHomeRequestAction = Schema.Literals(["connect", "disconnect"]);
export type ProviderHomeRequestAction = typeof ProviderHomeRequestAction.Type;

/** Requests approval in the target thread. Disconnect removes only GOAT's route override. */
export const ProviderHomeRequestInput = Schema.Struct({
  instanceId: ProviderInstanceId,
  action: ProviderHomeRequestAction,
  opencodexBaseUrl: Schema.optionalKey(TrimmedString),
});
export type ProviderHomeRequestInput = typeof ProviderHomeRequestInput.Type;

/** Public summary only; approval sessions and mutation preconditions remain private. */
export const ProviderHomeRequestResult = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("needs_human"),
    handoff: HandoffSummary,
    next: Schema.Struct({
      after: Schema.Literal("approval"),
      call: Schema.Literal("goat_provider_diagnose"),
    }),
  }),
  Schema.Struct({
    kind: Schema.Literal("error"),
    code: TrimmedNonEmptyString,
    message: TrimmedNonEmptyString,
    fix: Schema.optionalKey(ProviderDiagnosisFix),
  }),
]);
export type ProviderHomeRequestResult = typeof ProviderHomeRequestResult.Type;

/** MCP success schema: HandoffSummary contains a DateTime that must encode as JSON. */
export const ProviderHomeRequestResultJson = Schema.toCodecJson(ProviderHomeRequestResult);
