import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import type * as CheckpointService from "./CheckpointService.ts";
import type { RunExecutionServiceV2StartRootRunInput } from "./RunExecutionService.ts";

export type RunBaselineInput = Pick<
  RunExecutionServiceV2StartRootRunInput,
  "run" | "checkpointScope"
>;

export const captureRunBaseline = Effect.fn("RunExecutionService.captureBaseline")(function* (
  checkpoints: CheckpointService.CheckpointServiceV2["Service"],
  { run, checkpointScope }: RunBaselineInput,
) {
  if (checkpointScope === null) return;
  yield* checkpoints
    .captureBaseline({ scope: checkpointScope, ordinalWithinScope: Math.max(0, run.ordinal - 1) })
    .pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning(
              "orchestration V2 checkpoint baseline capture failed; starting provider without a baseline",
              { runId: run.id },
            ),
      ),
    );
});
