import type { EnvironmentProject } from "@goat/client-runtime/state/shell";
import type { VcsRef } from "@goat/client-runtime/state/vcs";

export function branchBadgeLabel(input: {
  readonly branch: VcsRef;
  readonly project: EnvironmentProject | null;
}): string | null {
  if (input.branch.current) {
    return "current";
  }
  if (input.branch.worktreePath && input.branch.worktreePath !== input.project?.workspaceRoot) {
    return "worktree";
  }
  if (input.branch.isRemote) {
    return "remote";
  }
  if (input.branch.isDefault) {
    return "default";
  }
  return null;
}
