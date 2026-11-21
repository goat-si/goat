import { GitCommandError, type WorktreeSubmodules } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { makeRestorePending } from "../orchestration-v2/goat/restorePending.ts";
import { verifyWorktreeRegistration } from "../orchestration-v2/goat/restoreSnapshot.ts";

export const makePullRequestWorktreeLifecycle = Effect.fn(
  "GitManager.pullRequestWorktreeLifecycle",
)(function* (git: GitVcsDriver["Service"]) {
  const pending = yield* makeRestorePending;
  const failure = (cwd: string, detail: string, cause?: unknown) =>
    new GitCommandError({
      operation: "GitManager.preparePullRequestThread",
      command: "git worktree",
      cwd,
      detail,
      cause,
    });
  const verify = Effect.fn("GitManager.verifyPullRequestWorktree")(function* (
    cwd: string,
    path: string,
    branch: string,
  ) {
    yield* verifyWorktreeRegistration({ projectCwd: cwd, worktreePath: path }).pipe(
      Effect.mapError((cause) =>
        failure(cwd, `Could not verify the worktree registration at ${path}.`, cause),
      ),
    );
    const head = yield* git.execute({
      operation: "GitManager.pullRequestWorktreeHead",
      cwd: path,
      args: ["symbolic-ref", "--quiet", "HEAD"],
    });
    if (head.stdout.trim() !== `refs/heads/${branch}`)
      return yield* failure(cwd, `The worktree at ${path} no longer uses branch ${branch}.`);
    return (yield* git.resolveCommit({ cwd: path, revision: "HEAD" })).commitSha;
  });
  return {
    verifyReusable: Effect.fn("GitManager.verifyReusablePullRequestWorktree")(function* (
      cwd: string,
      path: string,
      branch: string,
    ) {
      yield* verify(cwd, path, branch);
      yield* git.inspectExistingBranch({ cwd, branch, baseRef: `refs/heads/${branch}` });
      if (yield* pending.marked(path, cwd)) {
        return yield* failure(
          cwd,
          `The worktree at ${path} has unfinished preparation. Restore its workspace in GOAT, or back up its files and remove it using GOAT before trying again.`,
        );
      }
    }),
    create: Effect.fn("GitManager.createPullRequestWorktree")(function* (
      cwd: string,
      branch: string,
      options: {
        worktreesDirectory: Effect.Effect<string>;
        skipSetupHook: boolean;
        submodules: Effect.Effect<WorktreeSubmodules | null>;
        onWorktreeClaimed: ((path: string) => Effect.Effect<void>) | undefined;
      },
    ) {
      const head = yield* git.resolveCommit({ cwd, revision: `refs/heads/${branch}` });
      const created = yield* git.createWorktree(
        { cwd, refName: branch, path: null },
        {
          worktreesDirectory: yield* options.worktreesDirectory,
          skipSetupHook: options.skipSetupHook,
          submodules: yield* options.submodules,
          beforeAdd: (path) =>
            pending
              .write(
                path,
                {
                  restoredFrom: "branch",
                  headSha: head.commitSha,
                  snapshotSha: null,
                  snapshotRef: null,
                  applied: false,
                },
                cwd,
              )
              .pipe(Effect.mapError((cause) => failure(cwd, cause.message, cause))),
          ...(options.onWorktreeClaimed === undefined
            ? {}
            : {
                progress: {
                  onWorktreeClaimed: (path) =>
                    verify(cwd, path, branch).pipe(
                      Effect.flatMap((current) =>
                        current === head.commitSha
                          ? (options.onWorktreeClaimed?.(path) ?? Effect.void)
                          : Effect.void,
                      ),
                    ),
                },
              }),
        },
      );
      yield* verify(cwd, created.worktree.path, branch);
      return { ...created, pinnedHead: head.commitSha };
    }),
    finishSetup: (cwd: string, branch: string) =>
      Effect.fn("GitManager.finishPullRequestWorktreeSetup")(function* <E>(
        created: { readonly worktree: { readonly path: string }; readonly pinnedHead: string },
        targetHead: string | null,
        setup: (path: string) => Effect.Effect<void, E>,
      ) {
        const path = created.worktree.path;
        const beforeSetup =
          (yield* verify(cwd, path, branch)) === (targetHead ?? created.pinnedHead);
        if (beforeSetup) yield* setup(path);
        const isOnPullRequestHead =
          targetHead !== null && beforeSetup && (yield* verify(cwd, path, branch)) === targetHead;
        yield* pending
          .clear(path, cwd)
          .pipe(
            Effect.mapError((cause) =>
              failure(cwd, `Could not finish the worktree at ${path}: ${cause.message}`, cause),
            ),
          );
        return isOnPullRequestHead;
      }),
  };
});
