import * as DateTime from "effect/DateTime";

export const thread = {
  id: "thread",
  title: "Test thread",
  archivedAt: null as string | null,
  snoozedUntil: null as string | null,
  subagentOf: null as string | null,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  pendingRequestId: "request-1",
  session: null as { status: string } | null,
  completionNotification: undefined as string | undefined,
  launchedBy: undefined as
    | undefined
    | {
        kind: "launch";
        via: "delegate_task";
        threadId: string;
        environmentId: string;
        environmentLabel: null;
        threadTitle: null;
      },
  latestTurn: { turnId: "turn", state: "running", completedAt: null as string | null },
};
const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T07:00:00.000Z");

export function toV2ThreadShell(input: typeof thread) {
  const latestTurn = input.latestTurn;
  return {
    id: input.id,
    projectId: "project",
    title: input.title,
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      rootThreadId: input.subagentOf ?? input.id,
      parentThreadId: input.subagentOf,
      relationshipToParent: input.subagentOf === null ? null : "subagent",
    },
    forkedFrom: null,
    createdBy: "user",
    creationSource: input.subagentOf === null ? "web" : "mcp",
    launchedBy: input.launchedBy,
    latestRunId: latestTurn.turnId,
    activeRunId: null,
    status:
      latestTurn.state === "completed"
        ? "completed"
        : latestTurn.state === "error" || input.session?.status === "error"
          ? "failed"
          : "running",
    pendingRuntimeRequest: input.hasPendingUserInput
      ? { id: input.pendingRequestId, kind: "user_input", createdAt: SHELL_NOW }
      : input.hasPendingApprovals
        ? { id: input.pendingRequestId, kind: "command", createdAt: SHELL_NOW }
        : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletionNotification: input.completionNotification,
    notificationCompletedAt: null,
    latestRunCompletedAt: latestTurn.completedAt
      ? DateTime.makeUnsafe(latestTurn.completedAt)
      : undefined,
    archivedAt: input.archivedAt ? DateTime.makeUnsafe(input.archivedAt) : null,
    snoozedUntil: input.snoozedUntil ? DateTime.makeUnsafe(input.snoozedUntil) : null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}
