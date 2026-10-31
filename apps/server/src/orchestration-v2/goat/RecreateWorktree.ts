import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as GitWorkflowService from "../../git/GitWorkflowService.ts";

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
    }) {
      const { cwd, worktreePath, branch } = input;
      yield* gitWorkflow.pruneWorktrees({ cwd });
      const localBranchNames = yield* gitWorkflow.listLocalBranchNames(cwd);
      if (localBranchNames.includes(branch)) {
        yield* gitWorkflow.createWorktree({ cwd, refName: branch, path: worktreePath });
        return;
      }
      // Push keeps the tracking ref current, so recovery reads it without fetching.
      const pushedRef = `refs/remotes/origin/${branch}`;
      if (yield* gitWorkflow.hasCommit({ cwd, refName: pushedRef })) {
        yield* gitWorkflow.createWorktree({
          cwd,
          refName: pushedRef,
          newRefName: branch,
          path: worktreePath,
        });
        return;
      }
      const base = yield* resolveRecreateBase(cwd);
      if (base === null) {
        return yield* new WorktreeRecreateNoBaseError({ worktreePath, branch });
      }
      yield* gitWorkflow.createWorktree({
        cwd,
        refName: base.refName,
        newRefName: branch,
        ...(base.baseRefName === undefined ? {} : { baseRefName: base.baseRefName }),
        path: worktreePath,
      });
    },
    (effect, { worktreePath, branch }) =>
      effect.pipe(
        Effect.mapError((cause) =>
          cause._tag === "WorktreeRecreateNoBaseError"
            ? cause
            : new WorktreeRecreateError({ worktreePath, branch, cause }),
        ),
      ),
  );
});
