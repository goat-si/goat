import type { Project } from "@goat/contracts";
import { ThreadLaunchWorkspaceMissingError } from "./threadLaunchWorkspaceMissing.ts";
import type { OrchestrationV2ThreadLaunchWorkspaceStrategy as ThreadLaunchWorkspaceStrategy } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { WorkspacePaths } from "../workspace/WorkspacePaths.ts";

/**
 * Records an existing worktree in the server's own form, so a client's `C:/…`, shell `/c/…`
 * or `..` path compares equal to the paths git and the server produce, even when the folder
 * is gone and gets recreated later. The existence check below reports a missing one.
 */
export const nativeExistingWorktree = (
  workspacePaths: Option.Option<WorkspacePaths["Service"]>,
  strategy: ThreadLaunchWorkspaceStrategy,
) =>
  strategy.type !== "existing_worktree" || Option.isNone(workspacePaths)
    ? Effect.succeed(strategy)
    : workspacePaths.value.normalizeWorkspaceRoot(strategy.worktreePath).pipe(
        Effect.catchTags({
          WorkspaceRootNotExistsError: (error) => Effect.succeed(error.normalizedWorkspaceRoot),
          WorkspaceRootNotDirectoryError: (error) => Effect.succeed(error.normalizedWorkspaceRoot),
        }),
        Effect.map((worktreePath) => ({ ...strategy, worktreePath })),
        Effect.orElseSucceed(() => strategy),
      );

/** Fails only when a folder is missing or not a directory; any other stat failure is left to the launch. */
export const assertWorkspaceExists = Effect.fn("ThreadLaunchService.assertWorkspaceExists")(
  function* (
    workspacePaths: Option.Option<WorkspacePaths["Service"]>,
    project: Project,
    strategy: ThreadLaunchWorkspaceStrategy,
  ) {
    if (Option.isNone(workspacePaths)) return;
    const paths: ReadonlyArray<readonly ["project" | "worktree", string]> = [
      ["project", project.workspaceRoot],
      ...(strategy.type === "existing_worktree"
        ? [["worktree", strategy.worktreePath] as const]
        : []),
    ];
    for (const [kind, path] of paths) {
      const missing = yield* workspacePaths.value.normalizeWorkspaceRoot(path).pipe(
        Effect.as(false),
        Effect.catchTags({
          WorkspaceRootNotExistsError: () => Effect.succeed(true),
          WorkspaceRootNotDirectoryError: () => Effect.succeed(true),
        }),
        Effect.orElseSucceed(() => false),
      );
      if (missing)
        return yield* new ThreadLaunchWorkspaceMissingError({
          projectId: project.id,
          projectTitle: project.title,
          kind,
          path,
          remoteUrl: project.repositoryIdentity?.locator.remoteUrl ?? null,
        });
    }
  },
);
