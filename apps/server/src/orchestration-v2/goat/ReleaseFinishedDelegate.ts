import { CommandId, type RunId, type ThreadId } from "@goat/contracts";
import { delegatedTaskProgress } from "@goat/provider-core/server/subagentProjection";
import type { KeyedLock } from "@goat/shared/KeyedLock";
import * as Effect from "effect/Effect";
import type * as Orchestrator from "../Orchestrator.ts";
import type { ProjectionStoreV2Shape } from "../ProjectionStore.ts";
import type { makeSessionHasBackgroundWork } from "../SessionBackgroundWork.ts";

export function makeReleaseFinishedDelegate(input: {
  readonly projections: ProjectionStoreV2Shape;
  readonly locks: KeyedLock<ThreadId>;
  readonly dispatch: Orchestrator.OrchestratorV2Shape["dispatch"];
  readonly sessionHasBackgroundWork: ReturnType<typeof makeSessionHasBackgroundWork>;
}) {
  return Effect.fn("Orchestrator.releaseFinishedDelegateSessions")(
    function* (childThreadId: ThreadId, resultRunId: RunId) {
      yield* input.locks.withLock(
        childThreadId,
        Effect.gen(function* () {
          const child = yield* input.projections.getThreadRecords(
            childThreadId,
            ["runs", "messages", "subagents", "providerThreads", "providerSessions"],
            { messageRoles: ["user"] },
          );
          if (
            delegatedTaskProgress(child).state !== "result_available" ||
            child.providerThreads.some((thread) => (thread.pendingBackgroundTasks ?? []).length > 0)
          )
            return;
          for (const session of child.providerSessions) {
            if (
              session.status === "stopped" ||
              session.status === "error" ||
              session.capabilities.sessions.supportsMultipleProviderThreadsPerSession
            )
              continue;
            if (yield* input.sessionHasBackgroundWork(session, child.providerThreads)) continue;
            yield* input.dispatch({
              type: "provider-session.detach",
              commandId: CommandId.make(
                `command:system:delegated-task-release:${resultRunId}:${session.id}`,
              ),
              threadId: childThreadId,
              providerSessionId: session.id,
              reason: "Delegated task finished.",
            });
          }
        }),
      );
    },
    Effect.catchCause((cause) =>
      Effect.logWarning("Failed to release a finished delegate's provider session", { cause }),
    ),
  );
}
