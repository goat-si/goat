import { scheduledTaskWorktreeBaseRef } from "@goat/client-runtime/scheduled-task-worktree";
import type { EnvironmentId } from "@goat/contracts";
import { usePaginatedBranches } from "../../state/queries";
import { useProjects } from "../../state/entities";
import type { ScheduledTaskDraft } from "./scheduledTaskDraft";

export function useScheduledTaskBase(environmentId: EnvironmentId, draft: ScheduledTaskDraft) {
  const projects = useProjects()
    .filter(
      (project) =>
        project.environmentId === environmentId &&
        (project.archivedAt == null ||
          project.id === draft.projectId ||
          project.id === draft.task?.projectId),
    )
    .sort((a, b) => Number(b.pinnedAt != null) - Number(a.pinnedAt != null));
  const automatic =
    draft.task?.goatBotRoutine !== true && draft.workspace === "worktree" && !draft.baseRef.trim();
  const cwd = automatic
    ? (projects.find((project) => project.id === draft.projectId)?.workspaceRoot ?? null)
    : null;
  const refs = usePaginatedBranches({ environmentId, cwd, query: "" });
  return {
    projects,
    baseLoading: cwd !== null && refs.data === null && refs.error === null,
    worktreeBase: scheduledTaskWorktreeBaseRef(draft.baseRef, refs.refs),
  };
}
