import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import * as GitVcsDriver from "../../vcs/GitVcsDriver.ts";
import { parseRemoteNamesInGitOrder } from "../../git/remoteRefs.ts";
import { tryWithForeignWorkspaceSubtree } from "../../workspace/workspaceLease.ts";
import type { RestorePendingError } from "./restorePending.ts";
import {
  applySnapshotToWorktree,
  git,
  pathExists,
  verifyRestoredWorktree,
} from "./restoreSnapshot.ts";

class WorktreeRecreateError extends Schema.TaggedError<WorktreeRecreateError>()(
  "WorktreeRecreateError",
  {
    worktreePath: Schema.String,
    branch: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not recreate the worktree for branch '${this.branch}' at ${this.worktreePath}.`;
  }
}

class WorktreeRecreateNoBaseError extends Schema.TaggedError<WorktreeRecreateNoBaseError>()(
  "WorktreeRecreateNoBaseError",
  { worktreePath: Schema.String, branch: Schema.String },
) {
  override get message(): string {
    return `Could not recreate branch '${this.branch}' at ${this.worktreePath}: the project workspace has no commit to start it from.`;
  }
}

export class WorktreeSnapshotConflictError extends Schema.TaggedError<WorktreeSnapshotConflictError>()(
  "WorktreeSnapshotConflictError",
  {
    worktreePath: Schema.String,
    branch: Schema.String,
    expectedHead: Schema.String,
    actualHead: Schema.String,
  },
) {}

/**
 * Removes a worktree this restore created, through the removal that leaves Windows junction
 * targets alone. The caller holds the folder's lease, so only other servers are kept out.
 * Succeeds with whether the folder went; a failure is logged for the caller's retry state.
 */
export const makeDiscardWorktree = Effect.gen(function* () {
  // Optional so turn-start harnesses without Git keep plain recreation; the folder then stays.
  const vcs = yield* Effect.serviceOption(GitVcsDriver.GitVcsDriver);
  return Effect.fn("RecreateWorktree.discard")(function* (input: {
    readonly cwd: string;
    readonly worktreePath: string;
  }) {
    if (Option.isNone(vcs)) return false;
    const removed = yield* tryWithForeignWorkspaceSubtree(
      input.worktreePath,
      vcs.value.removeWorktree({ cwd: input.cwd, path: input.worktreePath, force: true }),
    ).pipe(Effect.result);
    const gone = removed._tag === "Success" && Option.isSome(removed.success);
    if (!gone)
      yield* Effect.logWarning("restore rollback kept the worktree", {
        worktreePath: input.worktreePath,
        cause: removed._tag === "Failure" ? removed.failure : "in use by another GOAT server",
      });
    return gone;
  });
});

export const makeRecreateMissingWorktree = Effect.gen(function* () {
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const discard = yield* makeDiscardWorktree;
  const resolveRecreateBase = Effect.fn("ProviderTurnStartService.resolveRecreateBase")(function* (
    cwd: string,
    remoteName: string | null,
  ) {
    // Recovery can follow an external checkout, before the status cache expires.
    yield* gitWorkflow.invalidateLocalStatus(cwd);
    const { refName: currentBranch } = yield* gitWorkflow.localStatus({ cwd });
    if (currentBranch !== null) {
      const refName = `refs/heads/${currentBranch}`;
      return { refName, baseRefName: refName };
    }
    const remoteHead = `refs/remotes/${remoteName}/HEAD`;
    if (remoteName !== null && (yield* gitWorkflow.hasCommit({ cwd, refName: remoteHead }))) {
      const { commitSha } = yield* gitWorkflow.resolveRemoteTrackingCommit({
        cwd,
        refName: "HEAD",
        fallbackRemoteName: remoteName,
      });
      // Start from the commit so the thread branch does not track the default branch.
      return { refName: commitSha, baseRefName: remoteHead };
    }
    if (yield* gitWorkflow.hasCommit({ cwd, refName: "HEAD" })) {
      return { refName: "HEAD", baseRefName: undefined };
    }
    return null;
  });
  return Effect.fn("ProviderTurnStartService.recreateMissingWorktree")(
    function* (input: {
      readonly cwd: string;
      readonly worktreePath: string;
      readonly branch: string;
      readonly snapshot?: { readonly snapshotSha: string; readonly headSha: string };
      /** Runs once the worktree exists, before the snapshot is applied; a failure rolls it back. */
      readonly onCreated?: (created: {
        readonly restoredFrom: "snapshot" | "branch" | "remote-branch" | "base";
        readonly headSha: string;
      }) => Effect.Effect<void, RestorePendingError>;
    }) {
      const { cwd, worktreePath, branch, snapshot, onCreated } = input;
      const runGit = (args: string[]) =>
        Effect.tryPromise({
          try: async () => (await git(cwd, args)).toString().trim(),
          catch: (cause) => new WorktreeRecreateError({ worktreePath, branch, cause }),
        });
      const existed = yield* Effect.tryPromise({
        try: () => pathExists(worktreePath),
        catch: (cause) => new WorktreeRecreateError({ worktreePath, branch, cause }),
      });
      yield* gitWorkflow.pruneWorktrees({ cwd });
      const localBranchNames = yield* gitWorkflow.listLocalBranchNames(cwd);
      let restoredFrom: "snapshot" | "branch" | "remote-branch" | "base";
      let refName: string;
      let newRefName: string | undefined;
      let baseRefName: string | undefined;
      if (snapshot) {
        const snapshotHead = yield* runGit(["rev-parse", `${snapshot.snapshotSha}^1^{commit}`]);
        if (snapshotHead !== snapshot.headSha) {
          return yield* new WorktreeSnapshotConflictError({
            worktreePath,
            branch,
            expectedHead: snapshot.headSha,
            actualHead: snapshotHead,
          });
        }
        if (localBranchNames.includes(branch)) {
          const actualHead = yield* runGit(["rev-parse", `refs/heads/${branch}^{commit}`]);
          if (actualHead !== snapshot.headSha) {
            return yield* new WorktreeSnapshotConflictError({
              worktreePath,
              branch,
              expectedHead: snapshot.headSha,
              actualHead,
            });
          }
          refName = branch;
        } else {
          refName = snapshot.headSha;
          newRefName = branch;
        }
        restoredFrom = "snapshot";
      } else if (localBranchNames.includes(branch)) {
        refName = branch;
        restoredFrom = "branch";
      } else {
        const remotes = parseRemoteNamesInGitOrder(
          yield* runGit(["remote"]).pipe(Effect.orElseSucceed(() => "")),
        );
        const remoteName = remotes.includes("origin") ? "origin" : (remotes[0] ?? null);
        if (
          remoteName !== null &&
          (yield* gitWorkflow.hasCommit({ cwd, refName: `refs/remotes/${remoteName}/${branch}` }))
        ) {
          refName = `refs/remotes/${remoteName}/${branch}`;
          restoredFrom = "remote-branch";
        } else {
          const base = yield* resolveRecreateBase(cwd, remoteName);
          if (base === null)
            return yield* new WorktreeRecreateNoBaseError({ worktreePath, branch });
          refName = base.refName;
          baseRefName = base.baseRefName;
          restoredFrom = "base";
        }
        newRefName = branch;
      }
      yield* gitWorkflow.createWorktree({
        cwd,
        refName,
        path: worktreePath,
        ...(newRefName === undefined ? {} : { newRefName }),
        ...(baseRefName === undefined ? {} : { baseRefName }),
      });
      return yield* Effect.gen(function* () {
        // Qualified, so a tag that shares the branch's name cannot stand in for it.
        const headSha =
          snapshot?.headSha ?? (yield* runGit(["rev-parse", `refs/heads/${branch}^{commit}`]));
        if (onCreated) yield* onCreated({ restoredFrom, headSha });
        if (snapshot)
          yield* applySnapshotToWorktree({ cwd: worktreePath, snapshotSha: snapshot.snapshotSha });
        yield* verifyRestoredWorktree({
          cwd: worktreePath,
          expectedPath: worktreePath,
          branch,
          expectedHead: headSha,
          ...(snapshot ? { snapshot: snapshot.snapshotSha } : {}),
        });
        return { restoredFrom, headSha };
      }).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            if (!existed) yield* discard({ cwd, worktreePath });
            return yield* Effect.failCause(cause);
          }),
        ),
      );
    },
    (effect, { worktreePath, branch }) =>
      effect.pipe(
        Effect.mapError((cause) =>
          cause._tag === "WorktreeRecreateNoBaseError" ||
          cause._tag === "WorktreeSnapshotConflictError"
            ? cause
            : new WorktreeRecreateError({ worktreePath, branch, cause }),
        ),
      ),
  );
});
