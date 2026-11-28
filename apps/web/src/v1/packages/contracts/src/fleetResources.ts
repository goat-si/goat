import * as Schema from "effect/Schema";

import { IsoDateTime, NonNegativeInt, PositiveInt, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { HostPressureSettings } from "./hostPressure.ts";
import { ProviderOptionSelections } from "./model.ts";
import { ModelSelection } from "./modelSelection.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Fleet limits, placement and model fallback chains (docs/internals/agentic-k8s.md, T3).
 * Limits and fallback chains are optional and off by default. Checkpoint replication preserves
 * existing channel defaults; ordinary watches require opt-in.
 */

/** A provider failure class or a step that cannot start (disabled, missing, out of quota). */
export const FallbackFailure = Schema.Literals([
  "usage_limit",
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
  "unavailable",
]);
export type FallbackFailure = typeof FallbackFailure.Type;

export const FallbackTrigger = Schema.Literals([
  "usage_limit",
  "provider_error",
  "transport_error",
  "unavailable",
]);
export type FallbackTrigger = typeof FallbackTrigger.Type;

export const FallbackChainId = TrimmedNonEmptyString.check(
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/),
);
export type FallbackChainId = typeof FallbackChainId.Type;

export const FallbackChainStep = Schema.Struct({
  instanceId: ProviderInstanceId,
  model: TrimmedNonEmptyString,
  options: Schema.optional(ProviderOptionSelections),
});
export type FallbackChainStep = typeof FallbackChainStep.Type;

export const DEFAULT_FALLBACK_ON: ReadonlyArray<FallbackTrigger> = ["usage_limit"];
export const DEFAULT_FALLBACK_COOLDOWN_MS = 15 * 60_000;

export const FallbackChain = Schema.Struct({
  steps: Schema.Array(FallbackChainStep).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  /** Default ["usage_limit"]. */
  on: Schema.optional(Schema.Array(FallbackTrigger)),
  /** Default steps.length - 1. */
  maxHops: Schema.optional(NonNegativeInt),
  /** How long a failed step is skipped. Default 15 minutes. */
  cooldownMs: Schema.optional(NonNegativeInt),
  /** "goals" (default) or also ordinary threads whose model is a step of the chain. */
  scope: Schema.optional(Schema.Literals(["goals", "goals_and_threads"])),
});
export type FallbackChain = typeof FallbackChain.Type;

/** The key for this machine in fleet.hosts; other keys are SSH aliases. */
export const FLEET_LOCAL_HOST_KEY = "local";

export const FleetHostLimits = Schema.Struct({
  /** Off stops new copies and retains existing copies until their normal expiry. Omitted preserves channel copies; ordinary watches require opt-in. */
  checkpointReplication: Schema.optional(Schema.Literals(["on", "off"])),
  /** Running plus queued threads this host may hold before goal work is refused. */
  maxThreads: Schema.optional(Schema.NullOr(PositiveInt)),
  allowGoals: Schema.optional(Schema.Boolean),
});
export type FleetHostLimits = typeof FleetHostLimits.Type;

export const FleetGoalDefaults = Schema.Struct({
  maxWorkers: Schema.optional(PositiveInt),
  maxAttemptsPerWorker: Schema.optional(PositiveInt),
  maxTurns: Schema.optional(PositiveInt),
  maxWallClockMs: Schema.optional(PositiveInt),
});
export type FleetGoalDefaults = typeof FleetGoalDefaults.Type;

export const DEFAULT_FLEET_GOAL_DEFAULTS = {
  maxWorkers: 3,
  maxAttemptsPerWorker: 3,
  maxTurns: 40,
  maxWallClockMs: 86_400_000,
} as const;
export const DEFAULT_FLEET_STALL_AFTER_MS = 1_200_000;
export const DEFAULT_FLEET_HOST_LOST_AFTER_MS = 300_000;

/**
 * Server settings key `fleet`. A patch replaces each top-level key it names, so sending
 * `fallbackChains` without a chain removes that chain.
 */
export const FleetSettings = Schema.Struct({
  /** Kill switch for goal actions. Default false. */
  controllerEnabled: Schema.optional(Schema.Boolean),
  /** Running plus queued threads across the fleet before goal work is refused. */
  maxRunningThreads: Schema.optional(Schema.NullOr(PositiveInt)),
  hosts: Schema.optional(Schema.Record(TrimmedNonEmptyString, FleetHostLimits)),
  goalDefaults: Schema.optional(FleetGoalDefaults),
  stallAfterMs: Schema.optional(PositiveInt),
  hostLostAfterMs: Schema.optional(PositiveInt),
  fallbackChains: Schema.optional(Schema.Record(FallbackChainId, FallbackChain)),
  /** Used by goals that name no chain. */
  defaultFallbackChain: Schema.optional(Schema.NullOr(FallbackChainId)),
  /** Resource pressure thresholds, notices and launch admission (ADR-0020). On by default. */
  pressure: Schema.optional(HostPressureSettings),
});
export type FleetSettings = typeof FleetSettings.Type;

export const PlacementRefusalCode = Schema.Literals([
  "not_ready",
  "cordoned",
  "excluded",
  "no_instance",
  "no_project",
  "quota_exhausted",
  "host_cap",
  "global_cap",
  "goals_not_allowed",
  "host_pressure",
  "placement_unavailable",
]);
export type PlacementRefusalCode = typeof PlacementRefusalCode.Type;

export const PlacementRefusal = Schema.Struct({
  code: PlacementRefusalCode,
  message: Schema.String,
});
export type PlacementRefusal = typeof PlacementRefusal.Type;

export const PlacementHostRefusal = Schema.Struct({
  host: Schema.NullOr(TrimmedNonEmptyString),
  reason: PlacementRefusal,
});
export type PlacementHostRefusal = typeof PlacementHostRefusal.Type;

export const PlacementDecision = Schema.Struct({
  at: IsoDateTime,
  owner: Schema.String,
  outcome: Schema.Literals(["placed", "refused"]),
  host: Schema.optional(Schema.NullOr(TrimmedNonEmptyString)),
  modelSelection: Schema.optional(ModelSelection),
  reason: Schema.String,
  refusals: Schema.optional(Schema.Array(PlacementHostRefusal)),
});
export type PlacementDecision = typeof PlacementDecision.Type;

export const SchedulerHostStatus = Schema.Struct({
  host: Schema.NullOr(TrimmedNonEmptyString),
  reachability: Schema.Literals(["ok", "stale", "unreachable", "unsupported"]),
  running: Schema.NullOr(NonNegativeInt),
  queued: Schema.NullOr(NonNegativeInt),
  maxThreads: Schema.NullOr(PositiveInt),
  allowGoals: Schema.Boolean,
  quotas: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      busiestPercent: Schema.NullOr(Schema.Number),
      exhausted: Schema.Boolean,
      resetsAt: Schema.optional(IsoDateTime),
    }),
  ),
  /** Why goal work would be refused here now; empty when the host can take it. */
  refusals: Schema.Array(PlacementRefusal),
});
export type SchedulerHostStatus = typeof SchedulerHostStatus.Type;

export const SchedulerStatus = Schema.Struct({
  controllerEnabled: Schema.Boolean,
  maxRunningThreads: Schema.NullOr(PositiveInt),
  /** Running plus queued threads on hosts that answered. */
  threads: NonNegativeInt,
  hosts: Schema.Array(SchedulerHostStatus),
  /** Steps skipped after a recent failure, until the time shown. */
  cooldowns: Schema.Array(
    Schema.Struct({
      instanceId: ProviderInstanceId,
      model: Schema.String,
      failure: FallbackFailure,
      until: IsoDateTime,
    }),
  ),
  decisions: Schema.Array(PlacementDecision),
});
export type SchedulerStatus = typeof SchedulerStatus.Type;

export const GoatSchedulerStatusInput = Schema.Struct({
  local: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "Read only this machine. Default false also reads every connected SSH host with this machine's keys.",
    }),
  ),
});
export type GoatSchedulerStatusInput = typeof GoatSchedulerStatusInput.Type;

export const GoatFallbackChainGetInput = Schema.Struct({
  id: Schema.optional(FallbackChainId),
});
export type GoatFallbackChainGetInput = typeof GoatFallbackChainGetInput.Type;

export const GoatFallbackChainGetResult = Schema.Struct({
  chains: Schema.Record(FallbackChainId, FallbackChain),
  defaultFallbackChain: Schema.NullOr(FallbackChainId),
});
export type GoatFallbackChainGetResult = typeof GoatFallbackChainGetResult.Type;

export const GoatFallbackChainSetInput = Schema.Struct({
  id: FallbackChainId,
  chain: Schema.NullOr(FallbackChain).annotate({
    description:
      "The whole chain; null deletes it (and clears defaultFallbackChain if it named it).",
  }),
  makeDefault: Schema.optional(
    Schema.Boolean.annotate({
      description:
        "true makes this the chain goals use when they name none; false clears that if it was this chain.",
    }),
  ),
});
export type GoatFallbackChainSetInput = typeof GoatFallbackChainSetInput.Type;

export const GoatFallbackChainSetResult = Schema.Struct({
  ...GoatFallbackChainGetResult.fields,
  /** Steps whose model this environment does not list; the chain is saved anyway. */
  warnings: Schema.Array(Schema.String),
});
export type GoatFallbackChainSetResult = typeof GoatFallbackChainSetResult.Type;
