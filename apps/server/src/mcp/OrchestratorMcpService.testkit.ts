import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import { GitCommandError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

export const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(layerNoFleetSync),
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  // Scheduling resolves a base ref; a checkout with no remote and a main branch is enough here.
  Layer.provide(
    Layer.mock(GitVcsDriver.GitVcsDriver)({
      resolvePrimaryRemoteName: (cwd) =>
        Effect.fail(
          new GitCommandError({
            operation: "GitVcsDriver.testkit",
            command: "git remote",
            cwd,
            detail: "No remote in the MCP testkit.",
          }),
        ),
      resolveCommit: () => Effect.succeed({ commitSha: "testkit-base" }),
    }),
  ),
);
