import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import {
  GoatHostStatusInput,
  GoatHostStatusResult,
  GoatHubDeviceVerifyInput,
  GoatHubDeviceVerifyResult,
  HubDeviceOperationInput,
  HubDeviceMcpResult,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as HostStatusMcpService from "../../HostStatusMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as HubParity from "../../../hub/HubParity.ts";
import * as HubMembership from "../../../hub/HubMembership.ts";

const HostStatusTool = Tool.make(agentSurfaceRegistry["host.status"].name, {
  description: agentSurfaceRegistry["host.status"].description,
  parameters: GoatHostStatusInput,
  success: GoatHostStatusResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HostStatusMcpService.HostStatusMcpService,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["host.status"]));

const VerifyTool = Tool.make(agentSurfaceRegistry["hub.device_verify"].name, {
  description: agentSurfaceRegistry["hub.device_verify"].description,
  parameters: GoatHubDeviceVerifyInput,
  success: GoatHubDeviceVerifyResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HubParity.HubParity,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["hub.device_verify"]));

const membershipTool = <
  const Path extends "hub.device_join" | "hub.device_leave" | "hub.device_repair",
>(
  path: Path,
) =>
  Tool.make(agentSurfaceRegistry[path].name, {
    description: agentSurfaceRegistry[path].description,
    parameters: HubDeviceOperationInput,
    success: HubDeviceMcpResult,
    failure: OrchestratorMcpFailure,
    failureMode: "return" as const,
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagementService.ThreadManagementService,
      HubMembership.HubMembership,
    ],
  }).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry[path]));

export const HostStatusToolkit = Toolkit.make(
  HostStatusTool,
  VerifyTool,
  membershipTool("hub.device_join"),
  membershipTool("hub.device_leave"),
  membershipTool("hub.device_repair"),
);
