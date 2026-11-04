import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";
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

export const makeRecreateMissingWorktree = Effect.gen(function* () {
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const resolveRecreateBase = Effect.fn("ProviderTurnStartService.resolveRecreateBase")(function* (
    cwd: string,
  ) {
    // Recovery can follow an external checkout, before the status cache expires.
    yield* gitWorkflow.invalidateLocalStatus(cwd);
    const { refName: currentBranch } = yield* gitWorkflow.localStatus({ cwd });
    if (currentBranch !== null) {
      const refName = `refs/heads/${currentBranch}`;
      return { refName, baseRefName: refName };
    }
    if (yield* gitWorkflow.hasCommit({ cwd, refName: "refs/remotes/origin/HEAD" })) {
      const { commitSha } = yield* gitWorkflow.resolveRemoteTrackingCommit({
        cwd,
        refName: "HEAD",
        fallbackRemoteName: "origin",
      });
      // Start from the commit so the thread branch does not track the default branch.
      return { refName: commitSha, baseRefName: "refs/remotes/origin/HEAD" };
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
    }) {
      const { cwd, worktreePath, branch, snapshot } = input;
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
      } else if (yield* gitWorkflow.hasCommit({ cwd, refName: `refs/remotes/origin/${branch}` })) {
        refName = `refs/remotes/origin/${branch}`;
        newRefName = branch;
        restoredFrom = "remote-branch";
      } else {
        const base = yield* resolveRecreateBase(cwd);
        if (base === null) return yield* new WorktreeRecreateNoBaseError({ worktreePath, branch });
        refName = base.refName;
        baseRefName = base.baseRefName;
        newRefName = branch;
        restoredFrom = "base";
      }
      const headSha = snapshot?.headSha ?? (yield* runGit(["rev-parse", `${refName}^{commit}`]));
      yield* gitWorkflow.createWorktree({
        cwd,
        refName,
        path: worktreePath,
        ...(newRefName === undefined ? {} : { newRefName }),
        ...(baseRefName === undefined ? {} : { baseRefName }),
      });
      return yield* Effect.gen(function* () {
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
            if (!existed) yield* runGit(["worktree", "remove", "--force", worktreePath]);
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
