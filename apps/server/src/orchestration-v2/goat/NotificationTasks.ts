import type {
  ThreadId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2Subagent,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as ProjectionStore from "../ProjectionStore.ts";
import type { OrchestratorProjectionError } from "../Orchestrator.ts";

export const makeNotificationTasks = (
  projectionStore: ProjectionStore.ProjectionStoreV2["Service"],
  mapError: (threadId: ThreadId, cause: unknown) => OrchestratorProjectionError,
) => {
  // Command reads omit settled tasks, but a completion notice counts its whole cohort.
  return (
    threadId: ThreadId,
    message: Pick<OrchestrationV2ConversationMessage, "delegatedCompletion">,
    loaded: ReadonlyArray<OrchestrationV2Subagent>,
  ) =>
    message.delegatedCompletion === undefined
      ? Effect.succeed(loaded)
      : projectionStore
          .getThreadRecords(threadId, ["subagents"], {
            subagentRunIds: [message.delegatedCompletion.parentRunId],
          })
          .pipe(
            Effect.map((records) => records.subagents),
            Effect.mapError((cause) => mapError(threadId, cause)),
          );
};
