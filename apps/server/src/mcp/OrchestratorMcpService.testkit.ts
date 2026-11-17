import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import { GitCommandError } from "@goat/contracts";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PreparationClaims from "../orchestration-v2/goat/PreparationClaims.ts";
import * as ThreadCommandExecutor from "../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

/** Real claims, so a delegation takes and releases its child's pending mark through them. */
export const layerTestClaims = PreparationClaims.layer.pipe(
  Layer.provide(ThreadCommandExecutor.layer),
  Layer.provide(NodeSqliteClient.layer({ filename: ":memory:" })),
);

/** The service with a launch service whose mark is real and whose other methods the test gives. */
export const layerOrchestratorServiceWith = (
  launch: (
    claims: PreparationClaims.PreparationClaims["Service"],
  ) => Partial<ThreadLaunchService.ThreadLaunchService["Service"]> = () => ({}),
) =>
  OrchestratorMcpService.layer.pipe(
    Layer.provide(layerNoFleetSync),
    Layer.provide(
      Layer.unwrap(
        Effect.gen(function* () {
          const claims = yield* PreparationClaims.PreparationClaims;
          return Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            preparationPending: claims.pending,
            ...launch(claims),
          });
        }),
      ).pipe(Layer.provide(layerTestClaims)),
    ),
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

export const layerOrchestratorService = layerOrchestratorServiceWith();
