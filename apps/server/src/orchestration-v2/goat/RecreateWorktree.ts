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
    return `Could not recreate branch '${this.branch}' at ${this.worktreePath}: the project workspace has no current branch to start it from (detached HEAD?).`;
  }
}

export const makeRecreateMissingWorktree = Effect.gen(function* () {
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
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
      // Recovery can follow an external checkout, before the status cache expires.
      yield* gitWorkflow.invalidateLocalStatus(cwd);
      const { refName: baseRef } = yield* gitWorkflow.localStatus({ cwd });
      if (baseRef === null) {
        return yield* new WorktreeRecreateNoBaseError({ worktreePath, branch });
      }
      yield* gitWorkflow.createWorktree({
        cwd,
        refName: `refs/heads/${baseRef}`,
        newRefName: branch,
        baseRefName: `refs/heads/${baseRef}`,
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
