import type { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as ProjectionStore from "../ProjectionStore.ts";
import type * as ThreadCommandExecutor from "../ThreadCommandExecutor.ts";

export const recoverTerminalSubagents = Effect.fn("Orchestrator.recoverTerminalSubagents")(
  function* <E>(
    projections: ProjectionStore.ProjectionStoreV2["Service"],
    lock: ThreadCommandExecutor.ThreadCommandExecutor["Service"],
    finalize: (threadId: ThreadId) => Effect.Effect<unknown, E>,
  ) {
    yield* projections.getRecoveryThreadIds("subagent-results").pipe(
      Effect.tap((threadIds) =>
        Effect.annotateCurrentSpan("recovery.subagentResultThreads", threadIds.length),
      ),
      Effect.flatMap((threadIds) =>
        Effect.forEach(
          threadIds,
          (threadId) =>
            Effect.gen(function* () {
              const thread = yield* projections.getThreadShell(threadId);
              const parentThreadId = thread?.lineage.parentThreadId;
              if (parentThreadId === undefined || parentThreadId === null) return;
              yield* lock.withLock(parentThreadId, finalize(threadId));
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("Failed to recover terminal app-owned subagent", {
                  childThreadId: threadId,
                  cause,
                }),
              ),
            ),
          { concurrency: 8, discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("Failed to inspect app-owned subagents during recovery", { cause }),
      ),
    );
  },
);
