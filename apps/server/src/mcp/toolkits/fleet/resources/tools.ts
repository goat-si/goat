import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import {
  GoatFallbackChainGetInput,
  GoatFallbackChainGetResult,
  GoatFallbackChainSetInput,
  GoatFallbackChainSetResult,
  GoatSchedulerStatusInput,
  OrchestratorMcpFailure,
  SchedulerStatus,
} from "@goat/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as Fallback from "../../../../fleet/resources/Fallback.ts";
import * as Placement from "../../../../fleet/resources/Placement.ts";
import * as ThreadManagementService from "../../../../orchestration-v2/ThreadManagementService.ts";
import { agentSurfaceAnnotations } from "../../../agentSurface.ts";
import * as HostStatusMcpService from "../../../HostStatusMcpService.ts";
import * as McpInvocationContext from "../../../McpInvocationContext.ts";

const shared = { failure: OrchestratorMcpFailure, failureMode: "return" as const };

const SchedulerStatusTool = Tool.make(agentSurfaceRegistry["scheduler.status"].name, {
  ...shared,
  description: agentSurfaceRegistry["scheduler.status"].description,
  parameters: GoatSchedulerStatusInput,
  success: SchedulerStatus,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HostStatusMcpService.HostStatusMcpService,
    Placement.Placement,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["scheduler.status"]));

const FallbackChainGetTool = Tool.make(agentSurfaceRegistry["fallback_chain.get"].name, {
  ...shared,
  description: agentSurfaceRegistry["fallback_chain.get"].description,
  parameters: GoatFallbackChainGetInput,
  success: GoatFallbackChainGetResult,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Fallback.FallbackChains,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["fallback_chain.get"]));

const FallbackChainSetTool = Tool.make(agentSurfaceRegistry["fallback_chain.set"].name, {
  ...shared,
  description: agentSurfaceRegistry["fallback_chain.set"].description,
  parameters: GoatFallbackChainSetInput,
  success: GoatFallbackChainSetResult,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Fallback.FallbackChains,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["fallback_chain.set"]));

export const FleetResourcesToolkit = Toolkit.make(
  SchedulerStatusTool,
  FallbackChainGetTool,
  FallbackChainSetTool,
);
