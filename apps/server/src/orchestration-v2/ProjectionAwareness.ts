import { isSideChatThread, type OrchestrationV2ThreadShell, type ThreadId } from "@goat/contracts";
import type { ProjectThreadAwarenessV2Input } from "@goat/shared/agentAwareness";
import type * as Effect from "effect/Effect";

export type AgentAwarenessThread = ProjectThreadAwarenessV2Input["thread"] &
  Pick<
    OrchestrationV2ThreadShell,
    | "projectId"
    | "archivedAt"
    | "activeRunId"
    | "latestRunId"
    | "latestRunCompletedAt"
    | "hasActionableProposedPlan"
  >;
export interface ProjectionAwarenessReader<E> {
  readonly getAgentAwarenessSnapshot: (
    threadId?: ThreadId,
  ) => Effect.Effect<
    { readonly snapshotSequence: number; readonly threads: ReadonlyArray<AgentAwarenessThread> },
    E
  >;
}
export const listedForAwareness = (thread: OrchestrationV2ThreadShell) =>
  thread.lineage.relationshipToParent !== "subagent" && !isSideChatThread(thread);
export function awarenessThread(thread: OrchestrationV2ThreadShell): AgentAwarenessThread {
  const {
    id,
    projectId,
    archivedAt,
    activeRunId,
    latestRunId,
    latestRunCompletedAt,
    hasActionableProposedPlan,
    title,
    lineage,
    sideChatOf,
    modelSelection,
    settledOverride,
    updatedAt,
    status,
    activityRunStatus,
    latestRunStopRequested,
    latestRunCompletionNotification,
    pendingRuntimeRequest,
    pendingBackgroundTasks,
  } = thread;
  return {
    id,
    projectId,
    archivedAt,
    activeRunId,
    latestRunId,
    latestRunCompletedAt,
    hasActionableProposedPlan,
    title,
    lineage,
    sideChatOf,
    modelSelection,
    settledOverride,
    updatedAt,
    status,
    activityRunStatus,
    latestRunStopRequested,
    latestRunCompletionNotification,
    pendingRuntimeRequest,
    pendingBackgroundTasks,
  };
}
