import type { EnvironmentProject } from "@goat/client-runtime/state/shell";
import {
  pendingDraftBranchNeedsRefs,
  resolvePendingDraftBranch,
  type PendingNewTask,
} from "../../state/pending-new-tasks-model";
import { useBranches } from "../../state/queries";
import { useNewTaskProjectDefaults } from "./use-new-task-project-defaults";

export function usePendingDraftBranch(task: PendingNewTask, project: EnvironmentProject | null) {
  const defaults = useNewTaskProjectDefaults(task.kind === "draft" ? project : null);
  const draftDefaults = {
    canChooseWorkspace: !defaults.isScratch,
    defaultMode: defaults.defaultWorkspaceMode,
    defaultModeSettled: defaults.defaultWorkspaceModeSettled,
  };
  const projectCwd = project?.workspaceRoot || null;
  const refs = useBranches({
    environmentId: task.environmentId,
    cwd:
      task.kind === "draft" && pendingDraftBranchNeedsRefs(task.draft, draftDefaults)
        ? projectCwd
        : null,
  });
  return task.kind === "draft"
    ? resolvePendingDraftBranch({
        draft: task.draft,
        defaults: draftDefaults,
        isGitRepo: refs.data?.isRepo ?? true,
        branches: refs.data?.refs ?? [],
        projectCwd,
      })
    : task.branch;
}
