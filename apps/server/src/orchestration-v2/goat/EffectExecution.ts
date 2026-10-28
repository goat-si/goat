import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as EffectOutbox from "../EffectOutbox.ts";
import * as ProviderTurnControlService from "../ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "../ProviderTurnStartService.ts";

export class OrchestrationEffectExecutionError extends Schema.TaggedError<OrchestrationEffectExecutionError>()(
  "OrchestrationEffectExecutionError",
  {
    effectId: Schema.String,
    effectType: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isOrchestrationEffectExecutionError = Schema.is(OrchestrationEffectExecutionError);
const isProviderTurnControlError = Schema.is(ProviderTurnControlService.ProviderTurnControlError);

export function hasCloudTrackingFailure(cause: Cause.Cause<unknown>): boolean {
  return cause.reasons.some((reason) => {
    if (!Cause.isFailReason(reason)) return false;
    const error = isOrchestrationEffectExecutionError(reason.error)
      ? reason.error.cause
      : reason.error;
    return isProviderTurnControlError(error) && error.reason === "tracking-unavailable";
  });
}

const isProviderTurnStartError = Schema.is(ProviderTurnStartService.ProviderTurnStartError);
const isWorkspaceLeaseBusyError = Schema.is(ProviderTurnStartService.WorkspaceLeaseBusyError);

export function workspaceLeaseBusy(cause: Cause.Cause<unknown>) {
  for (const reason of cause.reasons) {
    if (!Cause.isFailReason(reason)) continue;
    const startError = isOrchestrationEffectExecutionError(reason.error)
      ? reason.error.cause
      : reason.error;
    if (isProviderTurnStartError(startError) && isWorkspaceLeaseBusyError(startError.cause)) {
      return startError.cause;
    }
  }
  return undefined;
}

// A running effect blocks later work on its thread and its lease is never reclaimed in-process,
// so a stop that hangs must give up and fall through to the normal retry/fail path.
const DELEGATED_TASKS_STOP_TIMEOUT = Duration.seconds(30);

export const boundExecution =
  (effect: EffectOutbox.OrchestrationEffectV2) =>
  (execution: Effect.Effect<void, OrchestrationEffectExecutionError>) =>
    effect.request.type === "delegated-tasks.stop"
      ? execution.pipe(
          Effect.timeoutOrElse({
            duration: DELEGATED_TASKS_STOP_TIMEOUT,
            orElse: () =>
              Effect.fail(
                new OrchestrationEffectExecutionError({
                  effectId: effect.id,
                  effectType: effect.request.type,
                  cause: `Timed out after ${Duration.format(DELEGATED_TASKS_STOP_TIMEOUT)}.`,
                }),
              ),
          }),
        )
      : execution;
