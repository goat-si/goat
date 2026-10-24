/**
 * Fleet goals as one unit for the server: the store, the controller on the shared Scheduler,
 * and the tools' service. Health and Rescheduler (fleet/health/layer.ts) and Placement and
 * Fallback (fleet/resources) are provided above it, so goals and the fleet tools share one of each.
 */
import * as Layer from "effect/Layer";

import * as HostThreadsMcpService from "../../mcp/HostThreadsMcpService.ts";
import * as OrchestratorMcpService from "../../mcp/OrchestratorMcpService.ts";
import * as ThreadLaunchMcpService from "../../mcp/ThreadLaunchMcpService.ts";
import * as ProcessRunner from "../../processRunner.ts";
import * as RemoteReportService from "../../remoteReports/RemoteReportService.ts";
import * as ThreadResultService from "../../threadResults/ThreadResultService.ts";
import * as GoalController from "./GoalController.ts";
import * as GoalRecovery from "./GoalRecovery.ts";
import * as GoalService from "./GoalService.ts";
import * as GoalStore from "./GoalStore.ts";
import * as GoalWorkerRuntime from "./GoalWorkerRuntime.ts";

const layerRuntime = GoalWorkerRuntime.layer.pipe(
  Layer.provide(ThreadLaunchMcpService.layer),
  Layer.provide(HostThreadsMcpService.layer),
  Layer.provide(OrchestratorMcpService.layer),
  Layer.provide(RemoteReportService.layer),
  Layer.provide(ThreadResultService.layer),
);

const layerCore = GoalController.layer.pipe(
  Layer.provideMerge(GoalService.layer),
  Layer.provideMerge(GoalRecovery.layer.pipe(Layer.provide(ProcessRunner.layer))),
  Layer.provideMerge(layerRuntime),
  Layer.provideMerge(GoalStore.layer),
);

export const layer = GoalController.layerRunning.pipe(Layer.provideMerge(layerCore));
