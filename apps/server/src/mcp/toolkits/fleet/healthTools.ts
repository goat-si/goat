import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import {
  GoatHostCordonInput,
  GoatHostDrainInput,
  GoatHostScheduleResult,
  GoatHostUncordonInput,
  GoatThreadRescheduleInput,
  GoatThreadRescheduleResult,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as FleetHostStates from "../../../fleet/health/FleetHostStates.ts";
import * as HostHealthMonitor from "../../../fleet/health/HostHealthMonitor.ts";
import * as Rescheduler from "../../../fleet/health/Rescheduler.ts";
import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    FleetHostStates.FleetHostStates,
    HostHealthMonitor.HostHealthMonitor,
    Rescheduler.Rescheduler,
  ],
};

const HostCordonTool = Tool.make(agentSurfaceRegistry["host.cordon"].name, {
  ...shared,
  description: agentSurfaceRegistry["host.cordon"].description,
  parameters: GoatHostCordonInput,
  success: GoatHostScheduleResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["host.cordon"]));

const HostUncordonTool = Tool.make(agentSurfaceRegistry["host.uncordon"].name, {
  ...shared,
  description: agentSurfaceRegistry["host.uncordon"].description,
  parameters: GoatHostUncordonInput,
  success: GoatHostScheduleResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["host.uncordon"]));

const HostDrainTool = Tool.make(agentSurfaceRegistry["host.drain"].name, {
  ...shared,
  description: agentSurfaceRegistry["host.drain"].description,
  parameters: GoatHostDrainInput,
  success: GoatHostScheduleResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["host.drain"]));

const ThreadRescheduleTool = Tool.make(agentSurfaceRegistry["thread.reschedule"].name, {
  ...shared,
  dependencies: [...shared.dependencies, Profiles.PermissionProfiles],
  description: agentSurfaceRegistry["thread.reschedule"].description,
  parameters: GoatThreadRescheduleInput,
  success: GoatThreadRescheduleResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.reschedule"]));

/** T2's tools in the shared fleet toolkit folder; goal and scheduler tools sit beside them. */
export const FleetHealthToolkit = Toolkit.make(
  HostCordonTool,
  HostUncordonTool,
  HostDrainTool,
  ThreadRescheduleTool,
);
