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
