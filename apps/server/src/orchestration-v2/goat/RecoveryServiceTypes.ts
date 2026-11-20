import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import type * as ProviderRuntimeShutdown from "../ProviderRuntimeShutdown.ts";
import type { ProviderRuntimeRecoveryError } from "../ProviderRuntimeRecoveryErrors.ts";

export interface ProviderRuntimeRecoverySummary {
  readonly terminalizedRuns: number;
  readonly stoppedSessions: number;
  readonly closedRequests: number;
  readonly retiredEffects: number;
  readonly requeuedEffects: number;
}

export interface ProviderRuntimeReconciliationSummary {
  readonly terminalizedRuns: number;
  readonly stoppedSessions: number;
  readonly closedRequests: number;
  readonly retiredEffects: number;
  readonly requeuedEffects: number;
}

type ShutdownPreparation = Effect.Effect<
  ProviderRuntimeShutdown.ShutdownContinuationSummary,
  ProviderRuntimeRecoveryError
>;

export class ProviderRuntimeRecoveryService extends Context.Service<
  ProviderRuntimeRecoveryService,
  {
    readonly reconcile: (
      trigger: "startup" | "shutdown",
    ) => Effect.Effect<ProviderRuntimeReconciliationSummary, ProviderRuntimeRecoveryError>;
    readonly prepareForShutdown: ShutdownPreparation;
    readonly prepareForShutdownWithStopKind: (stopKind: "restart" | "quit") => ShutdownPreparation;
    readonly recover: Effect.Effect<ProviderRuntimeRecoverySummary, ProviderRuntimeRecoveryError>;
  }
>()("goat/orchestration-v2/ProviderRuntimeRecoveryService") {}
