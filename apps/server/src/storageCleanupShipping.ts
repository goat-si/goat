import * as Effect from "effect/Effect";

import type * as GitManager from "./git/GitManager.ts";
import { storageCleanupPullRequestMerged } from "./storageCleanupPullRequest.ts";
import type * as GitVcsDriver from "./vcs/GitVcsDriver.ts";

/** Whether a worktree's commits reached its repository's default branch, or why that is unknown. */
export type WorktreeShipping =
  | { readonly _tag: "integrated"; readonly remote: boolean; readonly merged: boolean }
  | { readonly _tag: "merged" }
  | { readonly _tag: "unshipped"; readonly reason: string }
  | { readonly _tag: "unknown"; readonly reason: string };

type DefaultBranch =
  | { readonly remote: string | null; readonly branch: string; readonly ref: string }
  | { readonly unknown: string };

const UNCONFIRMED = "so GOAT can't confirm this worktree's commits were shipped";

/**
 * Compares worktree heads with the remote default branch, fetched once per repository for one
 * cleanup pass; without a remote, with the branch the project checkout has. Anything it cannot
 * prove shipped is unshipped or unknown, and cleanup keeps it.
 */
export const makeWorktreeShipping = (
  git: GitVcsDriver.GitVcsDriver["Service"],
  gitManager: GitManager.GitManager["Service"],
) => {
  const defaults = new Map<string, DefaultBranch>();
  const resolveDefault = Effect.fn("StorageCleanup.resolveDefaultBranch")(function* (cwd: string) {
    const remotes = yield* git.execute({
      operation: "StorageCleanup.listRemotes",
      cwd,
      args: ["remote"],
    });
    if (remotes.stdout.trim() === "") {
      const projectHead = yield* git.execute({
        operation: "StorageCleanup.resolveProjectBranch",
        cwd,
        args: ["symbolic-ref", "--quiet", "HEAD"],
        allowNonZeroExit: true,
      });
      if (projectHead.exitCode !== 0) return { unknown: "project branch is unavailable" };
      const ref = projectHead.stdout.trim();
      return { remote: null, branch: ref.slice("refs/heads/".length), ref };
    }
    const remote = yield* git.resolvePrimaryRemoteName(cwd);
    // Without a local HEAD ref, only the remote can identify its default; a conventional name may be a feature branch.
    const branch =
      (yield* git.resolveDefaultBranchName(cwd, remote)) ??
      (yield* git
        .execute({
          operation: "StorageCleanup.resolveDefaultBranch",
          cwd,
          args: ["ls-remote", "--symref", "--", remote, "HEAD"],
          timeoutMs: 20_000,
        })
        .pipe(
          Effect.map(
            (result) => /^ref: refs\/heads\/(.+)\tHEAD\r?$/m.exec(result.stdout)?.[1] ?? null,
          ),
          Effect.orElseSucceed(() => null),
        ));
    if (branch === null) return { unknown: `default branch is unavailable, ${UNCONFIRMED}` };
    // A failed fetch leaves the tracking ref as old as the last fetch, so it proves nothing.
    const fetched = yield* git
      .fetchRemoteTrackingBranch({ cwd, remoteName: remote, remoteBranch: branch })
      .pipe(Effect.result);
    if (fetched._tag === "Failure")
      return { unknown: `couldn't refresh ${remote}/${branch}, ${UNCONFIRMED}` };
    return { remote, branch, ref: `refs/remotes/${remote}/${branch}` };
  });

  const pullRequestState = (pullRequest: GitManager.GitBranchPullRequest | null): string => {
    if (pullRequest === null) return "no merged pull request";
    if (pullRequest.state === "open") return `pull request #${pullRequest.number} is open`;
    if (pullRequest.state === "closed")
      return `pull request #${pullRequest.number} was closed without merging`;
    return `pull request #${pullRequest.number} merged other commits`;
  };

  return Effect.fn("StorageCleanup.worktreeShipping")(function* (input: {
    readonly repositoryCwd: string;
    readonly worktreePath: string;
    readonly branch: string;
    readonly headSha: string;
    /** "integrated" also asks for an integrated head, which the merge rule alone needs. */
    readonly pullRequest: "never" | "unshipped" | "integrated";
  }) {
    const cached = defaults.get(input.repositoryCwd);
    const resolved =
      cached ??
      (yield* resolveDefault(input.repositoryCwd).pipe(
        Effect.orElseSucceed(() => ({
          unknown: `the default branch couldn't be read, ${UNCONFIRMED}`,
        })),
      ));
    defaults.set(input.repositoryCwd, resolved);
    if ("unknown" in resolved) return { _tag: "unknown", reason: resolved.unknown } as const;
    const label =
      resolved.remote === null
        ? `the project branch ${resolved.branch}`
        : `${resolved.remote}/${resolved.branch}`;
    const base = yield* git
      .resolveCommit({ cwd: input.worktreePath, revision: resolved.ref })
      .pipe(Effect.result);
    if (base._tag === "Failure")
      return { _tag: "unknown", reason: `${label} is missing, ${UNCONFIRMED}` } as const;
    const ancestor = yield* git.execute({
      operation: "StorageCleanup.integratedBranch",
      cwd: input.worktreePath,
      args: ["merge-base", "--is-ancestor", input.headSha, base.success.commitSha],
      allowNonZeroExit: true,
    });
    if (ancestor.exitCode !== 0 && ancestor.exitCode !== 1)
      return { _tag: "unknown", reason: `couldn't compare with ${label}, ${UNCONFIRMED}` } as const;
    const integrated = ancestor.exitCode === 0;
    const lookup =
      resolved.remote !== null &&
      (input.pullRequest === "integrated" || (!integrated && input.pullRequest === "unshipped"))
        ? yield* gitManager
            .branchPullRequest({ cwd: input.worktreePath, branch: input.branch }, { refresh: true })
            .pipe(Effect.result)
        : null;
    const merged =
      lookup?._tag === "Success" &&
      storageCleanupPullRequestMerged(lookup.success, {
        branch: input.branch,
        defaultBranch: resolved.branch,
        headSha: input.headSha,
        integrated,
      });
    if (integrated)
      return { _tag: "integrated", remote: resolved.remote !== null, merged } as const;
    if (merged) return { _tag: "merged" } as const;
    const count = yield* git.execute({
      operation: "StorageCleanup.unshippedCommits",
      cwd: input.worktreePath,
      args: ["rev-list", "--count", `${base.success.commitSha}..${input.headSha}`],
    });
    const commits = count.stdout.trim();
    if (resolved.remote === null)
      return {
        _tag: "unshipped",
        reason: `unshipped commits (${commits} not on ${label}). Merge them into ${resolved.branch} to let cleanup remove this worktree`,
      } as const;
    const pullRequest =
      lookup === null
        ? null
        : lookup._tag === "Failure"
          ? "couldn't check for a merged pull request"
          : pullRequestState(lookup.success);
    return {
      _tag: "unshipped",
      reason: `unshipped commits (${commits} not in ${label}${pullRequest === null ? "" : `, ${pullRequest}`}). Merge them to let cleanup remove this worktree`,
    } as const;
  });
};
