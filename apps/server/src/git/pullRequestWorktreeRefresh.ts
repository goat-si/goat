import { GitManagerError } from "@goat/contracts";
import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

/**
 * Brings an existing local PR branch, just checked out in a new worktree, to the pull request's
 * head when a fast-forward is possible. Returns the verified target commit or null.
 */
export const makeRefreshNewPullRequestWorktree =
  <E>(deps: {
    readonly gitCore: GitVcsDriver.GitVcsDriver["Service"];
    readonly configureUpstream: (cwd: string) => Effect.Effect<void>;
    readonly changeRequestHeadRef: (cwd: string) => Effect.Effect<string, E>;
    readonly headSha: string | undefined;
    readonly localBranch: string;
  }) =>
  (cwd: string): Effect.Effect<string | null> => {
    const { gitCore, headSha } = deps;
    return Effect.gen(function* () {
      yield* deps.configureUpstream(cwd);
      const target = yield* deps.changeRequestHeadRef(cwd).pipe(
        Effect.flatMap((ref) => gitCore.fetchRefCommit({ cwd, ref })),
        Effect.filterOrFail(
          (resolved) => headSha === undefined || resolved.commitSha === headSha,
          () =>
            new GitManagerError({
              operation: "preparePullRequestThread",
              cwd,
              detail: "The fetched ref does not match the pull request head.",
            }),
        ),
        Effect.catch(() =>
          gitCore.resolveCommit({ cwd, revision: "@{upstream}" }).pipe(
            Effect.filterOrFail(
              (resolved) => resolved.commitSha === headSha,
              () =>
                new GitManagerError({
                  operation: "preparePullRequestThread",
                  cwd,
                  detail: "The configured upstream does not match the pull request head.",
                }),
            ),
          ),
        ),
      );
      return yield* gitCore
        .refreshCheckedOutBranch({ cwd, targetCommit: target.commitSha })
        .pipe(Effect.map((result) => (result.onTarget ? target.commitSha : null)));
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("GitManager.preparePullRequestThread existing branch refresh failed", {
          localBranch: deps.localBranch,
          cause: error,
        }).pipe(Effect.as(null)),
      ),
    );
  };
