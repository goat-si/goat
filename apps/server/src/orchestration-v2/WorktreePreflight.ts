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
    if (strategy.type !== "worktree" || (yield* managedFolders.isScratchProject(input.projectId)))
      return;
    if (input.commandId !== undefined) {
      const receipt = yield* receipts
        .getByCommandId(input.commandId)
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(receipt) && receipt.value.status === "accepted") return;
    }
    const { branch } = strategy;
    if (branch !== undefined && !isTemporaryWorktreeBranch(branch)) {
      const project = Option.getOrUndefined(
        yield* projects.getById(input.projectId).pipe(Effect.orElseSucceed(() => Option.none())),
      );
      if (project !== undefined) {
        const conflict = (yield* git
          .listLocalBranchNames(project.workspaceRoot)
          .pipe(Effect.orElseSucceed((): string[] => []))).find(
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
    }
    if (branch !== undefined) {
      const taken = yield* Effect.gen(function* () {
        const project = Option.getOrUndefined(yield* projects.getById(input.projectId));
        if (project === undefined) return undefined;
        const cwd = project.workspaceRoot;
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
    // `:/text` is a commit search, which cannot be asked for a commit type.
    if (strategy.baseRef.startsWith(":")) return;
    const { baseRef } = strategy;
    const unresolved = yield* Effect.gen(function* () {
      const project = Option.getOrUndefined(yield* projects.getById(input.projectId));
      if (project === undefined) return undefined;
      const cwd = project.workspaceRoot;
      // `git worktree add` reads `-` as the previous checkout.
      if (yield* git.hasCommit({ cwd, refName: baseRef === "-" ? "@{-1}" : baseRef }))
        return undefined;
      if (
        strategy.startFromOrigin === true &&
        (yield* git.resolveWorktreeBaseRemote({ cwd, refName: baseRef })) !== null
      )
        return undefined;
      // git worktree add accepts remote-tracking branches; let Git decide when any matching ref exists.
      if (yield* git.hasRefNamed({ cwd, refName: baseRef })) return undefined;
      return (yield* git.hasCommit({ cwd, refName: "HEAD" })) ? project : undefined;
    }).pipe(Effect.orElseSucceed(() => undefined));
    if (unresolved !== undefined)
      return yield* new ThreadLaunchBaseRefError({
        projectId: unresolved.id,
        projectTitle: unresolved.title,
        workspaceRoot: unresolved.workspaceRoot,
        baseRef,
      });
  });

  return checkWorktreeBase;
}
