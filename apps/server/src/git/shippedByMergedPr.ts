import * as Effect from "effect/Effect";
import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

export const shippedByMergedPr = Effect.fn("GitManager.shippedByMergedPr")(function* (
  git: GitVcsDriver.GitVcsDriver["Service"],
  cwd: string,
  defaultBranch: string | null,
  pr: { readonly state: string; readonly baseRef: string } | null,
  headSha: string | null,
) {
  if (pr?.state !== "merged" || headSha === null) return false;
  const base =
    defaultBranch ??
    (yield* git.resolvePrimaryRemoteName(cwd).pipe(
      Effect.flatMap((remote) => git.resolveDefaultBranchName(cwd, remote)),
      Effect.orElseSucceed(() => null),
    ));
  if (!(base === null ? pr.baseRef === "main" || pr.baseRef === "master" : pr.baseRef === base))
    return false;
  return yield* git.resolveCommit({ cwd, revision: "HEAD" }).pipe(
    Effect.map(({ commitSha }) => commitSha === headSha),
    Effect.orElseSucceed(() => false),
  );
});
