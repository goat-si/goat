import type { OrchestrationV2ThreadProjection, RunId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as EffectOutbox from "../EffectOutbox.ts";

export const survivorQueuedRuns = Effect.fn("CodexSurvivorQueuedRuns.find")(function* (
  outbox: EffectOutbox.EffectOutboxV2["Service"],
  command: { readonly threadId: ThreadId; readonly restartContinuationOfRunId?: RunId | undefined },
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "providerTurns">,
) {
  if (command.restartContinuationOfRunId === undefined) return new Set<RunId>();
  const guard = yield* outbox.getStartGuard;
  if (
    !guard.survivors.some(
      (binding) =>
        binding.threadId === command.threadId &&
        binding.sourceRunId === command.restartContinuationOfRunId,
    )
  )
    return new Set<RunId>();
  const starts = yield* outbox
    .listNeverAttemptedStarts(command.threadId)
    .pipe(Effect.orElseSucceed(() => []));
  return new Set(
    projection.runs
      .filter(
        (run) =>
          run.status === "starting" &&
          starts.some(
            (effect) =>
              effect.request.type === "provider-turn.start" && effect.request.runId === run.id,
          ) &&
          !projection.providerTurns.some(
            (turn) => turn.runAttemptId === run.activeAttemptId && turn.nativeTurnRef?.nativeId,
          ),
      )
      .map((run) => run.id),
  );
});
