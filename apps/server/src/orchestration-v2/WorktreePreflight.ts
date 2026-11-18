import { ProjectId } from "@goat/contracts";
import { isTemporaryWorktreeBranch } from "@goat/shared/git";
import { normalizeProjectPathForComparison } from "@goat/shared/path";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { uniqueCommitsProblem } from "../vcs/GitVcsDriverCore.ts";
import type * as GitWorkflow from "../git/GitWorkflowService.ts";
import type * as ProjectService from "../project/ProjectService.ts";
import type * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import type * as CommandReceiptStore from "./CommandReceiptStore.ts";
import type { ThreadLaunchService } from "./ThreadLaunchService.ts";

export class ThreadLaunchBaseRefError extends Schema.TaggedError<ThreadLaunchBaseRefError>()(
  "ThreadLaunchBaseRefError",
  {
    projectId: ProjectId,
    projectTitle: Schema.String,
    workspaceRoot: Schema.String,
    baseRef: Schema.String,
  },
) {
  override get message(): string {
    return `Base ref "${this.baseRef}" does not resolve to a commit in project "${this.projectTitle}" (${this.workspaceRoot}).`;
  }
}

export class ThreadLaunchNotRepositoryError extends Schema.TaggedError<ThreadLaunchNotRepositoryError>()(
  "ThreadLaunchNotRepositoryError",
  {
    projectId: ProjectId,
    projectTitle: Schema.String,
    workspaceRoot: Schema.String,
    /** Why Git could not say; set when detection itself failed. */
    checkFailed: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    const project = `project "${this.projectTitle}" (${this.workspaceRoot})`;
    return this.checkFailed === undefined
      ? `Project "${this.projectTitle}" (${this.workspaceRoot}) is not a Git repository.`
      : `GOAT could not check whether ${project} is a Git repository (${this.checkFailed}).`;
  }
}

export type WorktreePreflightError =
  | ThreadLaunchBaseRefError
  | ThreadLaunchBranchError
  | ThreadLaunchBranchConflictError
  | ThreadLaunchNotRepositoryError;

export class ThreadLaunchBranchConflictError extends Schema.TaggedError<ThreadLaunchBranchConflictError>()(
  "ThreadLaunchBranchConflictError",
  {
    projectId: ProjectId,
    projectTitle: Schema.String,
    branch: Schema.String,
    conflictingBranch: Schema.String,
  },
) {
  override get message(): string {
    return `Branch "${this.branch}" cannot be created in project "${this.projectTitle}": branch "${this.conflictingBranch}" exists.`;
  }
}

export class ThreadLaunchBranchError extends Schema.TaggedError<ThreadLaunchBranchError>()(
  "ThreadLaunchBranchError",
  {
    projectId: ProjectId,
    projectTitle: Schema.String,
    workspaceRoot: Schema.String,
    branch: Schema.String,
    worktreePath: Schema.NullOr(Schema.String),
    /** Why a launch cannot reuse the branch, such as commits its base lacks. */
    problem: Schema.String,
  },
) {
  override get message(): string {
    return this.worktreePath === null
      ? `Branch "${this.branch}" already exists in project "${this.projectTitle}" (${this.workspaceRoot}) and ${this.problem}, so a new worktree cannot reuse it.`
      : `Branch "${this.branch}" is already checked out at ${this.worktreePath} in project "${this.projectTitle}" and ${this.problem}, so a new worktree cannot reuse it.`;
  }
}

export function makeWorktreePreflight({
  projects,
  git,
  receipts,
  managedFolders,
}: {
  projects: ProjectService.ProjectService["Service"];
  git: GitWorkflow.GitWorkflowService["Service"];
  receipts: CommandReceiptStore.CommandReceiptStoreV2["Service"];
  managedFolders: ManagedProjectFolders.ManagedProjectFolders["Service"];
}) {
  const checkWorktreeBase: ThreadLaunchService["Service"]["checkWorktreeBase"] = Effect.fn(
    "ThreadLaunchService.checkWorktreeBase",
  )(function* (input) {
    const strategy = input.workspaceStrategy;
    if (strategy.type !== "worktree") return;
    const commandId = input.commandId;
    const [scratch, receipt, projectOption] = yield* Effect.all(
      [
        managedFolders.isScratchProject(input.projectId),
        commandId === undefined
          ? Effect.succeedNone
          : receipts.getByCommandId(commandId).pipe(Effect.orElseSucceed(() => Option.none())),
        projects.getById(input.projectId).pipe(Effect.orElseSucceed(() => Option.none())),
      ],
      { concurrency: 3 },
    );
    if (scratch || Option.exists(receipt, (value) => value.status === "accepted")) return;
    const project = Option.getOrUndefined(projectOption);
    if (project === undefined) return;
    const cwd = project.workspaceRoot;
    const { branch, baseRef } = strategy;
    const checksBranch = branch !== undefined && !isTemporaryWorktreeBranch(branch);
    const [root, branches, localBase] = yield* Effect.all(
      [
        Effect.result(git.repositoryRoot(cwd)),
        checksBranch
          ? git.listLocalBranchNames(cwd).pipe(Effect.orElseSucceed((): string[] => []))
          : Effect.succeed([]),
        // Git reads `-` as the previous checkout and `:/text` as a commit search.
        baseRef.startsWith(":")
          ? Effect.succeed(true)
          : git
              .hasCommit({ cwd, refName: baseRef === "-" ? "@{-1}" : baseRef })
              .pipe(Effect.orElseSucceed(() => true)),
      ],
      { concurrency: 3 },
    );
    if (root._tag === "Failure" || root.success === null)
      return yield* new ThreadLaunchNotRepositoryError({
        projectId: project.id,
        projectTitle: project.title,
        workspaceRoot: cwd,
        ...(root._tag === "Failure"
          ? { checkFailed: root.failure.message.split("\n")[0] ?? "" }
          : {}),
      });
    if (checksBranch) {
      const conflict = branches.find(
        (existing) => existing.startsWith(`${branch}/`) || branch.startsWith(`${existing}/`),
      );
      if (conflict !== undefined)
        return yield* new ThreadLaunchBranchConflictError({
          projectId: project.id,
          projectTitle: project.title,
          branch,
          conflictingBranch: conflict,
        });
    }
    if (branch !== undefined) {
      const taken = yield* Effect.gen(function* () {
        // A branch left by an earlier attempt is reused when that loses nothing; an
        // unresolvable base leaves the decision to provisioning, which fetches it first.
        const state = yield* git.inspectExistingBranch({ cwd, branch, baseRef: strategy.baseRef });
        if (state === null) return undefined;
        const problem =
          state.uniqueCommits > 0
            ? uniqueCommitsProblem(state.uniqueCommits, strategy.baseRef)
            : state.dirty
              ? "has uncommitted changes there"
              : state.worktreePath !== null &&
                  normalizeProjectPathForComparison(state.worktreePath) ===
                    normalizeProjectPathForComparison(cwd)
                ? "is the project's main checkout"
                : null;
        return problem === null
          ? undefined
          : { project, worktreePath: state.worktreePath, problem };
      }).pipe(Effect.orElseSucceed(() => undefined));
      if (taken !== undefined)
        return yield* new ThreadLaunchBranchError({
          projectId: taken.project.id,
          projectTitle: taken.project.title,
          workspaceRoot: taken.project.workspaceRoot,
          branch,
          worktreePath: taken.worktreePath,
          problem: taken.problem,
        });
    }
    if (localBase) return;
    const unresolved = yield* Effect.gen(function* () {
      if (
        strategy.startFromOrigin === true &&
        (yield* git.resolveWorktreeBaseRemote({ cwd, refName: baseRef })) !== null
      )
        return undefined;
      // git worktree add accepts remote-tracking branches; let Git decide when any matching ref exists.
      if (yield* git.hasRefNamed({ cwd, refName: baseRef })) return undefined;
      return yield* git.hasCommit({ cwd, refName: "HEAD" });
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (unresolved === true)
      return yield* new ThreadLaunchBaseRefError({
        projectId: project.id,
        projectTitle: project.title,
        workspaceRoot: cwd,
        baseRef,
      });
  });

  return checkWorktreeBase;
}
