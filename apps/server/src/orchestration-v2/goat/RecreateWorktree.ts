import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
import { parseRemoteNamesInGitOrder } from "../../git/remoteRefs.ts";
import type { RestorePendingError } from "./restorePending.ts";
import { applySnapshotToWorktree, git, verifyRestoredWorktree } from "./restoreSnapshot.ts";

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

export const makeRecreateMissingWorktree = Effect.gen(function* () {
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
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
      readonly beforeCreate?: (created: {
        readonly restoredFrom: "snapshot" | "branch" | "remote-branch" | "base";
        readonly headSha: string;
      }) => Effect.Effect<void, RestorePendingError>;
    }) {
      const { cwd, worktreePath, branch, snapshot, beforeCreate } = input;
      const runGit = (args: string[]) =>
        Effect.tryPromise({
          try: async () => (await git(cwd, args)).toString().trim(),
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
        yield* runGit(["rev-parse", "--verify", `${snapshot.snapshotSha}^2^{tree}`]);
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
      const target = restoredFrom === "branch" ? `refs/heads/${branch}` : refName;
      const headSha =
        snapshot?.headSha ??
        (yield* runGit(["rev-parse", "--verify", "--end-of-options", `${target}^{commit}`]));
      if (beforeCreate) yield* beforeCreate({ restoredFrom, headSha });
      yield* gitWorkflow.createWorktree({
        cwd,
        refName,
        path: worktreePath,
        ...(newRefName === undefined ? {} : { newRefName }),
        ...(baseRefName === undefined ? {} : { baseRefName }),
      });
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
