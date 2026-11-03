import type { ThreadId } from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

export const runShutdownContinuationTasks = Effect.fn(
  "ProviderRuntimeRecovery.runShutdownContinuationTasks",
)(function* <E, R>(
  threadIds: ReadonlyArray<ThreadId>,
  task: (id: ThreadId) => Effect.Effect<boolean, E, R>,
) {
  const results = yield* Effect.forEach(
    threadIds,
    (threadId) =>
      task(threadId).pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("Failed to prepare a restart continuation", { threadId, cause }).pipe(
              Effect.as(false),
            ),
        ),
      ),
    { concurrency: 4 },
  );
  return { candidates: threadIds.length, continued: results.filter(Boolean).length };
});
