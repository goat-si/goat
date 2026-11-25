import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as CheckpointRollbackService from "./CheckpointRollbackService.ts";

export const unrelatedProject = Option.some({
  workspaceRoot: "/nonexistent/goat-rollback-project",
} as never);
export const layerCheckpointRollbackService = CheckpointRollbackService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      NodeServices.layer,
      Layer.mock(ServerConfig.ServerConfig)({
        worktreesDir: "/synthetic-worktrees",
        stateDir: "/synthetic-state",
      } as never),
      ServerSettings.layerTest(),
      Layer.mock(GitWorkflow.GitWorkflowService)({}),
      Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeed(unrelatedProject) }),
    ),
  ),
);
