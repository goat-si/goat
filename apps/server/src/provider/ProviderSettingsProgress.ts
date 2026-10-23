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
  HandoffError,
  ProviderDiagnoseOnHostInput,
  ProviderInstanceConfig,
  ProviderInstanceId,
  ProviderInstanceSummary,
  ProviderManageResult,
} from "@goat/contracts";
import * as Exit from "effect/Exit";
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

/**
 * What the person who approved a change is told when it did not apply: a change that failed is
 * not one they asked for wrongly, and one that may have landed must not be approved again blindly.
 */
export const approvalError = (outcome: ProviderSettingsOutcome | undefined) =>
  new HandoffError(
    outcome?.state === "failed"
      ? { reason: "invalid_request", outcome: "apply_failed", detail: outcome.message }
      : outcome?.state === "unknown_outcome"
        ? { reason: "invalid_request", outcome: "apply_unknown", detail: outcome.message }
        : { reason: "invalid_request" },
  );

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
const encodeProgressSync = Schema.encodeSync(ProgressJson);

/**
 * What a setup approval did, kept so the asking thread hears it: the instance it turned on, or
 * that it could not. Nothing is kept when there was nothing for GOAT to turn on.
 */
export const setupProgress = (outcome: Exit.Exit<ProviderManageResult | undefined, unknown>) =>
  Exit.isSuccess(outcome)
    ? outcome.value === undefined
      ? undefined
      : encodeProgressSync({
          version: 1,
          effects: {},
          outcome: { state: "applied", result: outcome.value },
        })
    : encodeProgressSync({
        version: 1,
        effects: {},
        outcome: {
          state: "failed",
          reason: "invalid_request",
          message: "GOAT could not turn the provider instance on.",
        },
      });
