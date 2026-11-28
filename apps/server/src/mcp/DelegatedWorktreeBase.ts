import * as Effect from "effect/Effect";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export const delegatedWorktreeBase = Effect.fn("delegatedWorktreeBase")(function* (
  git: GitVcsDriver.GitVcsDriver["Service"],
  cwd: string,
  branch: string | null,
  commitSha: string,
) {
  const matches =
    branch !== null &&
    (yield* git.resolveCommit({ cwd, revision: `refs/heads/${branch}` }).pipe(
      Effect.map((resolved) => resolved.commitSha === commitSha),
      Effect.orElseSucceed(() => false),
    ));
  return {
    type: "worktree" as const,
    baseRef: matches ? branch : commitSha,
    startFromOrigin: false,
  };
});
