import { sanitizeBranchFragment } from "@goat/shared/git";
import * as Effect from "effect/Effect";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

/** Find a branch name that does not conflict with another ref's parent or child. */
function choosePullRequestBranch(
  preferred: string,
  number: number,
  suffix: string,
  localBranches: ReadonlySet<string>,
): string {
  const creatable = (name: string) =>
    !name
      .split("/")
      .slice(0, -1)
      .some((_, index, parts) => localBranches.has(parts.slice(0, index + 1).join("/"))) &&
    ![...localBranches].some((branch) => branch.startsWith(`${name}/`));
  if (creatable(preferred)) return preferred;
  const flat = `goat-pr-${number}-${suffix.replaceAll("/", "-")}`;
  for (let attempt = 1; ; attempt++) {
    const candidate = attempt === 1 ? flat : `${flat}-${attempt}`;
    if (creatable(candidate)) return candidate;
  }
}

export const resolvePullRequestWorktreeLocalBranchName = Effect.fn(
  "GitManager.resolvePullRequestWorktreeLocalBranchName",
)(function* (
  cwd: string,
  pullRequest: {
    readonly isCrossRepository?: boolean | undefined;
    readonly headBranch: string;
    readonly number: number;
  },
  gitCore: GitVcsDriver.GitVcsDriver["Service"],
) {
  if (!pullRequest.isCrossRepository) return pullRequest.headBranch;
  const suffix = sanitizeBranchFragment(pullRequest.headBranch).trim() || "head";
  const result = yield* gitCore.execute({
    operation: "GitManager.preparePullRequestThread.localBranches",
    cwd,
    args: ["for-each-ref", "--format=%(refname:lstrip=2)", "refs/heads"],
    timeoutMs: 5_000,
  });
  const branches = new Set(result.stdout.split("\n").filter(Boolean));
  return choosePullRequestBranch(
    `t3code/pr-${pullRequest.number}/${suffix}`,
    pullRequest.number,
    suffix,
    branches,
  );
});
