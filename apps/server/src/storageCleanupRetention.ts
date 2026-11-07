import type { WorktreeCleanupRules } from "@goat/contracts";

/** Rank distinct worktree paths by the most recent activity of any owning thread. */
export function rankWorktrees(worktrees: ReadonlyArray<{ path: string; activityAt: number }>) {
  const activity = new Map<string, number>();
  for (const worktree of worktrees) {
    activity.set(
      worktree.path,
      Math.max(activity.get(worktree.path) ?? -Infinity, worktree.activityAt),
    );
  }
  return new Map(
    [...activity]
      .sort(
        ([leftPath, left], [rightPath, right]) => right - left || leftPath.localeCompare(rightPath),
      )
      .map(([path], index) => [path, index] as const),
  );
}

/** Additional rules; deleted-thread eligibility remains controlled by worktreeOnDelete. */
export function retentionReason(input: {
  rules: Pick<WorktreeCleanupRules, "worktreeOnArchive" | "worktreeKeepRecent">;
  archived: boolean;
  pinned: boolean;
  deleted: boolean;
  rank: number | undefined;
}): string | null {
  if (input.deleted || input.pinned) return null;
  if (input.archived && input.rules.worktreeOnArchive) return "thread was archived";
  const keepRecent = input.rules.worktreeKeepRecent;
  if (keepRecent !== null && input.rank !== undefined && input.rank >= keepRecent)
    return `beyond the most recent ${keepRecent} worktrees`;
  return null;
}
