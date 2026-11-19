import { unquoteGitPath } from "./gitQuotedPath.ts";

/**
 * Line-form `git worktree list --porcelain` in the `-z` shape: Git for Windows may end lines
 * with CR, and the line form C-quotes unusual paths, which `-z` output never does.
 */
export function worktreeListLinesToFields(stdout: string): string {
  return stdout
    .split("\n")
    .map((line) => {
      const field = line.endsWith("\r") ? line.slice(0, -1) : line;
      const value = field.slice("worktree ".length);
      return field.startsWith("worktree ") && value.length > 1 && /^".*"$/su.test(value)
        ? `worktree ${unquoteGitPath(value)}`
        : field;
    })
    .join("\0");
}

export function parseWorktreeBranchPaths(stdout: string): ReadonlyMap<string, string> {
  const worktreePaths = new Map<string, string>();
  let currentPath: string | null = null;
  let currentBranch: string | null = null;
  let currentPrunable = false;

  const flush = () => {
    if (currentPath !== null && currentBranch !== null && !currentPrunable) {
      worktreePaths.set(currentBranch, currentPath);
    }
    currentPath = null;
    currentBranch = null;
    currentPrunable = false;
  };

  for (const field of stdout.split("\0")) {
    if (field === "") {
      flush();
    } else if (field.startsWith("worktree ")) {
      currentPath = field.slice("worktree ".length);
    } else if (field.startsWith("branch refs/heads/")) {
      currentBranch = field.slice("branch refs/heads/".length);
    } else if (field === "prunable" || field.startsWith("prunable ")) {
      currentPrunable = true;
    }
  }
  flush();

  return worktreePaths;
}
