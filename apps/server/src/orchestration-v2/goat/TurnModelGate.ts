import {
  parseGoalCommand,
  type ProviderInstanceId,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * Whether a turn start opens its session without starting a model turn, so the new-turn model
 * check would only get in its way: adopting a Codex turn that survived a restart (the adapter
 * adopts it instead of submitting), or a goal command that only reads, pauses or clears the goal.
 */
export const startsNoModelTurn = Effect.fn("TurnModelGate.startsNoModelTurn")(function* (
  survivors: Option.Option<{
    readonly get: (
      instanceId: ProviderInstanceId,
      threadId: ThreadId,
    ) => Effect.Effect<{ readonly sourceRunId: RunId } | undefined>;
  }>,
  run: {
    readonly threadId: ThreadId;
    readonly modelSelection: { readonly instanceId: ProviderInstanceId };
    readonly restartContinuationOfRunId?: RunId | undefined;
  },
  message: { readonly text: string; readonly attachments?: ReadonlyArray<unknown> } | undefined,
) {
  if (run.restartContinuationOfRunId !== undefined) {
    if (Option.isNone(survivors)) return false;
    const binding = yield* survivors.value.get(run.modelSelection.instanceId, run.threadId);
    return binding?.sourceRunId === run.restartContinuationOfRunId;
  }
  const command = message === undefined ? null : parseGoalCommand(message);
  return command?.type === "show" || command?.type === "pause" || command?.type === "clear";
});
