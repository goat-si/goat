import { GitManagerError } from "@goat/contracts";
import * as Effect from "effect/Effect";

import type * as GitVcsDriver from "../vcs/GitVcsDriver.ts";

/**
 * Brings an existing local PR branch, just checked out in a new worktree, to the pull request's
 * head only when nothing is lost: it fast-forwards a branch that is behind, and resets one only
 * when its head was published (or equals the upstream before the fetch). A branch with commits
 * of its own stays where it is. True when the checkout ends on the head; never fails.
 */
export const makeRefreshNewPullRequestWorktree =
  <E>(deps: {
    readonly gitCore: GitVcsDriver.GitVcsDriver["Service"];
    readonly configureUpstream: (cwd: string) => Effect.Effect<void>;
    readonly changeRequestHeadRef: (cwd: string) => Effect.Effect<string, E>;
    readonly headSha: string | undefined;
    readonly localBranch: string;
  }) =>
  (cwd: string): Effect.Effect<boolean> => {
    const { gitCore, headSha } = deps;
    return Effect.gen(function* () {
      const upstreamCommitBeforeFetch = yield* gitCore
        .resolveCommit({ cwd, revision: "@{upstream}" })
        .pipe(
          Effect.map((resolved) => resolved.commitSha),
          Effect.orElseSucceed(() => null),
        );
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
      const { commitSha: headCommit } = yield* gitCore.resolveCommit({ cwd, revision: "HEAD" });
      // A head that was ever published loses nothing when reset, even if a fetch already moved its upstream.
      const gitLines = (args: ReadonlyArray<string>) =>
        gitCore
          .execute({
            operation: "GitManager.preparePullRequestThread.publishedHead",
            cwd,
            args,
            allowNonZeroExit: true,
            timeoutMs: 5_000,
          })
          .pipe(
            Effect.map((result) =>
              result.exitCode === 0 ? result.stdout.split("\n").filter(Boolean) : [],
            ),
          );
      const publishedHead =
        (yield* gitLines(["for-each-ref", "--contains", headCommit, "refs/remotes"])).length > 0 ||
        (yield* gitLines(["log", "--walk-reflogs", "--format=%H", "@{upstream}"])).includes(
          headCommit,
        );
      return yield* gitCore
        .refreshCheckedOutBranch({
          cwd,
          targetCommit: target.commitSha,
          resetWhenHeadCommit: publishedHead ? headCommit : upstreamCommitBeforeFetch,
        })
        .pipe(Effect.map((result) => result.onTarget));
    }).pipe(
      Effect.catch((error) =>
        Effect.logWarning("GitManager.preparePullRequestThread existing branch refresh failed", {
          localBranch: deps.localBranch,
          cause: error,
        }).pipe(Effect.as(false)),
      ),
    );
  };
