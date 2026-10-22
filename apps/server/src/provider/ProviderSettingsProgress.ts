/**
 * What an approved provider settings change has done, kept with its handoff's continuation so a
 * restart resumes only effects it can prove (docs/internals/agent-surface.md, Idempotency).
 *
 * Each effect is marked started before it runs and done after. An effect left at started is
 * repeated only when repeating it is proven safe; otherwise the change ends as unknown_outcome
 * and names the read that settles it. The plan fixes the instance id and entry before the first
 * effect, so a resumed add writes the same instance instead of deriving a new id.
 */
import {
  ProviderDiagnoseOnHostInput,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ProviderInstanceSummary,
  ProviderManageResult,
} from "@goat/contracts";
import * as Schema from "effect/Schema";

const ProviderSettingsEffect = Schema.Literals(["install", "save", "link", "remote"]);
export type ProviderSettingsEffect = typeof ProviderSettingsEffect.Type;
const EffectState = Schema.optionalKey(Schema.Literals(["started", "done"]));

export const ProviderSettingsOutcome = Schema.Union([
  Schema.Struct({ state: Schema.Literal("applied"), result: ProviderManageResult }),
  Schema.Struct({
    state: Schema.Literal("failed"),
    /** Absent when the change was refused before any effect ran. */
    effect: Schema.optionalKey(ProviderSettingsEffect),
    /** The domain's own code, such as an OrchestratorMcpFailure code. */
    reason: Schema.String,
    message: Schema.String,
  }),
  Schema.Struct({
    state: Schema.Literal("unknown_outcome"),
    effect: ProviderSettingsEffect,
    reason: Schema.String,
    message: Schema.String,
    /** The read that tells whether the effect happened. */
    reconcile: Schema.Struct({
      call: Schema.Literal("goat_provider_diagnose"),
      arguments: ProviderDiagnoseOnHostInput,
    }),
  }),
]);
export type ProviderSettingsOutcome = typeof ProviderSettingsOutcome.Type;

export const ProviderSettingsProgress = Schema.Struct({
  version: Schema.Literal(1),
  plan: Schema.optionalKey(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      instance: ProviderInstanceConfig,
      install: Schema.Boolean,
      linkTo: Schema.optionalKey(ProviderInstanceId),
    }),
  ),
  effects: Schema.Struct({
    install: EffectState,
    save: EffectState,
    link: EffectState,
    remote: EffectState,
  }),
  installed: Schema.optionalKey(Schema.Struct({ agentId: Schema.String, version: Schema.String })),
  linked: Schema.optionalKey(ProviderInstanceSummary),
  outcome: Schema.optionalKey(ProviderSettingsOutcome),
});
export type ProviderSettingsProgress = typeof ProviderSettingsProgress.Type;

const ProgressJson = Schema.toCodecJson(ProviderSettingsProgress);
export const encodeProgress = Schema.encodeEffect(ProgressJson);
export const decodeProgress = Schema.decodeUnknownEffect(ProgressJson);
