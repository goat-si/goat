import { layerNoFleetSync } from "../goatclaw/FleetSync.testkit.ts";
import * as Layer from "effect/Layer";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as OrchestratorMcpService from "./OrchestratorMcpService.ts";

export const layerOrchestratorService = OrchestratorMcpService.layer.pipe(
  Layer.provide(layerNoFleetSync),
  Layer.provide(Layer.mock(ThreadLaunchService.ThreadLaunchService)({})),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
);
