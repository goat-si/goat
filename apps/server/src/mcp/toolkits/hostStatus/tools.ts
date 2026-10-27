import { withClientRequestId } from "../keyedParameters.ts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import {
  ChildReadyAddress,
  ChildReadyConnectionInput,
  ChildReadyConnectionResult,
  ChildReadyPrepareInput,
  ChildReadyResult,
  GoatHostStatusInput,
  GoatHostStatusResult,
  GoatHubOpenCodexSyncInput,
  GoatHubDeviceVerifyInput,
  GoatHubDeviceVerifyResult,
  HubDeviceSetupInput,
  HubDeviceOperationInput,
  hubDeviceToolResult,
  OpenCodexSyncReport,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as HostStatusMcpService from "../../HostStatusMcpService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as HubParity from "../../../hub/HubParity.ts";
import * as HubMembership from "../../../hub/HubMembership.ts";
import * as OpenCodexSync from "../../../hub/OpenCodexSync.ts";
import * as ChildReady from "../../../opencodex/OpenCodexChildReady.ts";
import * as ChildBootstrap from "../../../opencodex/OpenCodexChildBootstrap.ts";

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
    parameters: withClientRequestId(HubDeviceOperationInput),
    success: hubDeviceToolResult(agentSurfaceRegistry[path].name),
    failure: OrchestratorMcpFailure,
    failureMode: "return" as const,
    dependencies: [
      McpInvocationContext.McpInvocationContext,
      ThreadManagementService.ThreadManagementService,
      HubMembership.HubMembership,
    ],
  }).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry[path]));

const OpenCodexSyncTool = Tool.make(agentSurfaceRegistry["hub.opencodex_sync"].name, {
  description: agentSurfaceRegistry["hub.opencodex_sync"].description,
  parameters: GoatHubOpenCodexSyncInput,
  success: OpenCodexSyncReport,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    OpenCodexSync.OpenCodexSync,
    Profiles.PermissionProfiles,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["hub.opencodex_sync"]));

const ChildPrepareTool = Tool.make(agentSurfaceRegistry["hub.child_prepare"].name, {
  description: agentSurfaceRegistry["hub.child_prepare"].description,
  parameters: ChildReadyPrepareInput,
  success: ChildReadyResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, ChildReady.OpenCodexChildReady],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["hub.child_prepare"]));

const ChildConnectionTool = Tool.make(agentSurfaceRegistry["hub.child_connection"].name, {
  description: agentSurfaceRegistry["hub.child_connection"].description,
  parameters: ChildReadyConnectionInput,
  success: ChildReadyConnectionResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ChildReady.OpenCodexChildReady,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["hub.child_connection"]));

const ChildStatusTool = Tool.make(agentSurfaceRegistry["hub.child_status"].name, {
  description: agentSurfaceRegistry["hub.child_status"].description,
  parameters: ChildReadyAddress,
  success: ChildReadyResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, ChildReady.OpenCodexChildReady],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["hub.child_status"]));

const DeviceSetupTool = Tool.make(agentSurfaceRegistry["hub.device_setup"].name, {
  description: agentSurfaceRegistry["hub.device_setup"].description,
  parameters: HubDeviceSetupInput,
  success: ChildReadyResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ChildBootstrap.OpenCodexChildBootstrap,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["hub.device_setup"]));

export const HostStatusToolkit = Toolkit.make(
  HostStatusTool,
  VerifyTool,
  membershipTool("hub.device_join"),
  membershipTool("hub.device_leave"),
  membershipTool("hub.device_repair"),
  ChildPrepareTool,
  ChildConnectionTool,
  ChildStatusTool,
  DeviceSetupTool,
  OpenCodexSyncTool,
);
