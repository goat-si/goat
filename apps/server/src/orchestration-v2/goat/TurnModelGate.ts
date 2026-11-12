import {
  parseGoalCommand,
  type ProviderInstanceId,
  type RunId,
  type ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * Whether a turn start opens without starting a model turn: a Codex survivor adoption (the adapter
 * checks the model itself if no survivor is left), or a goal read, pause or clear. A continuation
 * carrying a restart note reaches the adapter as a new turn, which never adopts.
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
  noteContinuation: boolean,
) {
  if (run.restartContinuationOfRunId !== undefined) {
    if (noteContinuation || Option.isNone(survivors)) return false;
    const binding = yield* survivors.value.get(run.modelSelection.instanceId, run.threadId);
    return binding?.sourceRunId === run.restartContinuationOfRunId;
  }
  const command = message === undefined ? null : parseGoalCommand(message);
  return command?.type === "show" || command?.type === "pause" || command?.type === "clear";
});
