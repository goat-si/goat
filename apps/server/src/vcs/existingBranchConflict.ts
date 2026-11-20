export function uniqueCommitsProblem(count: number, baseRef: string): string {
  return `has ${count} commit${count === 1 ? "" : "s"} that ${baseRef} does not`;
}

/** Why an existing branch cannot be reused, plus the launch that continues it. */
export function existingBranchConflictDetail(input: {
  readonly branch: string;
  readonly problem: string;
  readonly worktreePath: string | null;
  readonly suggestedPath: string;
}): string {
  const workspace = JSON.stringify({
    type: "existing_worktree",
    worktreePath: input.worktreePath ?? input.suggestedPath,
    branch: input.branch,
  });
  const relaunch = `relaunch with workspaceStrategy (workspace for ssh.thread_launch through goat_call) ${workspace}`;
  const resume =
    input.worktreePath === null
      ? `To continue it, run git worktree add "${input.suggestedPath}" ${input.branch}, then ${relaunch}.`
      : `To continue in that worktree, ${relaunch}.`;
  return `Branch ${input.branch} already exists and ${input.problem}, so GOAT will not reuse or reset it. ${resume} To start fresh, launch with a different branch name.`;
}
