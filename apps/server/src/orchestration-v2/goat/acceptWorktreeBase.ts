import { CommandId, type Project, type RunId, type ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import type { ThreadManagementService } from "../ThreadManagementService.ts";
import { ThreadLaunchBaseRefError } from "../WorktreePreflight.ts";

export const acceptWorktreeBase = Effect.fn("ThreadLaunchService.acceptWorktreeBase")(
  function* (input: {
    git: GitWorkflowService["Service"];
    threads: ThreadManagementService["Service"];
    project: Project;
    requestedBaseRef: string;
    startRef: string;
    baseRefName: string;
    pinnedHead: string | undefined;
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
                  baseRef: input.requestedBaseRef,
                  cause,
                })
              : cause,
          ),
        )).commitSha;
    const pin = { commitSha, baseRefName: input.baseRefName };
    if (runId !== null) {
      const identity = {
        commandId: CommandId.make(`${input.commandId}:progress:worktree`),
        threadId: input.threadId,
        runId,
      };
      yield* threads.dispatch(
        input.alreadyPinned
          ? { ...identity, type: "prepared-run.progress", phase: "worktree" }
          : { ...identity, type: "prepared-run.pin-base", basePin: pin },
      );
    }
    return pin;
  },
);
