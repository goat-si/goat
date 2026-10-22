import {
  latestProviderTurnForAttempt,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
} from "@goat/contracts";
import * as Effect from "effect/Effect";

import type { ServerDrainingError } from "../../runtimeAdmission.ts";
import { resolveMessageDispatchIntent } from "../CommandPolicy.ts";
import type {
  OrchestratorProjectionError,
  OrchestratorV2DispatchResult,
  OrchestratorV2Error,
} from "../Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";

type DispatchEffect = Effect.Effect<OrchestratorV2DispatchResult, OrchestratorV2Error>;

export interface DispatchAdmissionDeps {
  readonly admission: {
    readonly admit: <A, E, R>(
      effect: Effect.Effect<A, E, R>,
      options?: { readonly continuation: boolean },
    ) => Effect.Effect<A, E | ServerDrainingError, R>;
  };
  readonly projectionStore: ProjectionStoreV2Shape;
  readonly isBlockingRun: (run: OrchestrationV2Run) => boolean;
  readonly OrchestratorProjectionError: typeof OrchestratorProjectionError;
}

/**
 * Runs a command's dispatch through server drain admission. The Orchestrator calls
 * this inside the command's thread lock, so the steering check below reads the same
 * state the dispatch will.
 */
export const makeDispatchAdmission = (deps: DispatchAdmissionDeps) => {
  const { admission, projectionStore, isBlockingRun, OrchestratorProjectionError } = deps;
  return (command: OrchestrationV2ServerCommand, effect: DispatchEffect): DispatchEffect => {
    // Resuming a held queue starts its next run, so it is new work like a message.
    if (
      command.type === "delegated_task.request" ||
      command.type === "prepared-run.retry" ||
      command.type === "queue.resume"
    ) {
      return admission.admit(effect);
    }
    if (command.type !== "message.dispatch") return effect;
    if (
      command.notification !== undefined ||
      command.delegatedCompletion !== undefined ||
      command.restartContinuationOfRunId !== undefined ||
      command.usageLimitContinuationOfRunId !== undefined
    )
      return admission.admit(effect, { continuation: true });
    // Normal serving adds only the in-flight counter. Resolve steering under the
    // thread lock only after drain admission refuses it, so it cannot become a new turn.
    return admission.admit(effect).pipe(
      Effect.catchTags({
        ServerDrainingError: (error) =>
          Effect.gen(function* () {
            if (
              command.deliveryIntent === undefined &&
              command.dispatchMode.type !== "steer_active" &&
              command.dispatchMode.type !== "restart_active"
            )
              return yield* error;
            const projection = yield* projectionStore
              .getThreadRecords(command.threadId, [
                "runs",
                "messages",
                "providerTurns",
                "providerThreads",
                "providerSessions",
              ])
              .pipe(
                Effect.mapError(
                  (cause) => new OrchestratorProjectionError({ threadId: command.threadId, cause }),
                ),
              );
            const mode = resolveMessageDispatchIntent(
              projection,
              command.dispatchMode,
              command.deliveryIntent,
            );
            if (mode.type !== "steer_active" && mode.type !== "restart_active") return yield* error;
            const target = projection.runs.find((run) => run.id === mode.targetRunId);
            const turn = latestProviderTurnForAttempt(
              projection.providerTurns.filter(
                (candidate) => candidate.nodeId === target?.rootNodeId,
              ),
              target?.activeAttemptId,
            );
            if (target === undefined || !isBlockingRun(target) || turn?.status === "completed")
              return yield* error;
            return yield* admission.admit(effect, { continuation: true });
          }),
      }),
    );
  };
};
