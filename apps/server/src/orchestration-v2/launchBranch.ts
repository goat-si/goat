import * as Effect from "effect/Effect";
import type { GitWorkflowService } from "../git/GitWorkflowService.ts";
import type { ThreadLaunchWorkspaceStrategy } from "./ThreadLaunchService.ts";

export const launchBranch = (
  git: GitWorkflowService["Service"],
  strategy: ThreadLaunchWorkspaceStrategy,
  workspaceRoot: string,
) =>
  strategy.type === "root" && strategy.branch === undefined
    ? git.currentBranch(workspaceRoot)
    : Effect.succeed(strategy.branch ?? null);
