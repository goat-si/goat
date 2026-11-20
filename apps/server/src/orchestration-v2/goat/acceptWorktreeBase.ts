import { CommandId, type Project, type RunId, type ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Data from "effect/Data";
import type { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import type { ThreadManagementService } from "../ThreadManagementService.ts";
import type { ThreadLaunchWorkspaceStrategy } from "../threadLaunchTypes.ts";
import { ThreadLaunchBaseRefError } from "../WorktreePreflight.ts";

class MissingWorktreeBasePin extends Data.TaggedError("MissingWorktreeBasePin")<{
  readonly message: string;
}> {}

export const acceptWorktreeBase = Effect.fn("ThreadLaunchService.acceptWorktreeBase")(
  function* (input: {
    git: GitWorkflowService["Service"];
    threads: ThreadManagementService["Service"];
    project: Project;
    workspaceStrategy: Extract<ThreadLaunchWorkspaceStrategy, { type: "worktree" }>;
    startRef: string;
    baseRefName: string;
    pinnedHead: string | undefined;
    checkoutBranch: string | undefined;
    commandId: CommandId;
    threadId: ThreadId;
    runId: RunId | null;
    alreadyPinned: boolean;
  }) {
    const { git, threads, project, runId } = input;
    const commitSha =
      input.pinnedHead ??
      (yield* git
        .resolveCommit({
          cwd: project.workspaceRoot,
          revision: input.startRef,
        })
        .pipe(
          Effect.mapError((cause) =>
            cause.reason === "ref_not_found"
              ? new ThreadLaunchBaseRefError({
                  projectId: project.id,
                  projectTitle: project.title,
                  workspaceRoot: project.workspaceRoot,
                  baseRef: input.workspaceStrategy.baseRef,
                  cause,
                })
              : cause,
          ),
        )).commitSha;
    const pin = {
      commitSha,
      baseRefName: input.baseRefName,
      ...(input.checkoutBranch === undefined ? {} : { checkoutBranch: input.checkoutBranch }),
    };
    if (runId !== null) {
      const identity = {
        commandId: CommandId.make(
          input.alreadyPinned
            ? `${input.commandId}:progress:worktree`
            : `${input.commandId}:pin-base`,
        ),
        threadId: input.threadId,
        runId,
      };
      yield* threads.dispatch(
        input.alreadyPinned
          ? { ...identity, type: "prepared-run.progress", phase: "worktree" }
          : {
              ...identity,
              type: "prepared-run.pin-base",
              basePin: pin,
              workspaceStrategy: input.workspaceStrategy,
            },
      );
      const { runs } = yield* threads.getThreadRecords(input.threadId, ["runs"], {
        runIds: [runId],
      });
      const persisted = runs.find(
        (run) => run.id === runId && run.status === "preparing",
      )?.workspacePreparationBasePin;
      if (persisted === undefined) {
        return yield* new MissingWorktreeBasePin({
          message: `No accepted worktree base was recorded for run ${runId}.`,
        });
      }
      return persisted;
    }
    return pin;
  },
);
