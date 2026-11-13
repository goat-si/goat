import { ResourceTelemetryHistoryInput, ServerProcessResourceHistoryInput } from "@goat/contracts";
import * as Processes from "../../../diagnostics/ProcessResourceMonitor.ts";
import * as Telemetry from "../../../resourceTelemetry/ResourceTelemetry.ts";
import * as ReadSchemas from "../../scopedReadSchemas.ts";
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
  HubDeviceMoveInput,
  HubDeviceOperationInput,
  HubDeviceRoutesInput,
  HubDeviceRoutesResult,
  HubDeviceRoutesUpdateInput,
  HubDeviceRoutesUpdateResult,
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
import * as DisposableAttach from "../../../hub/disposable/DisposableAttach.ts";
import {
  HubMachineAttachInput,
  HubMachineList,
  HubMachineListInput,
  HubMachineReissueInput,
  HubMachineStatus,
} from "@goat/contracts";

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

const MoveTool = Tool.make(agentSurfaceRegistry["hub.device_move"].name, {
  description: agentSurfaceRegistry["hub.device_move"].description,
  parameters: withClientRequestId(HubDeviceMoveInput),
  success: hubDeviceToolResult(agentSurfaceRegistry["hub.device_move"].name),
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HubMembership.HubMembership,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["hub.device_move"]));

const RoutesTool = Tool.make(agentSurfaceRegistry["hub.device_routes"].name, {
  description: agentSurfaceRegistry["hub.device_routes"].description,
  parameters: HubDeviceRoutesInput,
  success: HubDeviceRoutesResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, HubMembership.HubMembership],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["hub.device_routes"]));

const RoutesUpdateTool = Tool.make(agentSurfaceRegistry["hub.device_routes_update"].name, {
  description: agentSurfaceRegistry["hub.device_routes_update"].description,
  parameters: withClientRequestId(HubDeviceRoutesUpdateInput),
  success: HubDeviceRoutesUpdateResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HubMembership.HubMembership,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["hub.device_routes_update"]));

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

const ProcessHistoryTool = Tool.make(agentSurfaceRegistry["host.process_history"].name, {
  description: agentSurfaceRegistry["host.process_history"].description,
  parameters: ServerProcessResourceHistoryInput,
  success: ReadSchemas.ProcessHistoryResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, Processes.ProcessResourceMonitor],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["host.process_history"]));
const ResourceHistoryTool = Tool.make(agentSurfaceRegistry["host.resource_history"].name, {
  description: agentSurfaceRegistry["host.resource_history"].description,
  parameters: ResourceTelemetryHistoryInput,
  success: ReadSchemas.ResourceHistoryResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext, Telemetry.ResourceTelemetry],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["host.resource_history"]));

const MachineAttachTool = Tool.make(agentSurfaceRegistry["hub.machine_attach"].name, {
  description: agentSurfaceRegistry["hub.machine_attach"].description,
  parameters: HubMachineAttachInput,
  success: HubMachineStatus,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    Profiles.PermissionProfiles,
    ThreadManagementService.ThreadManagementService,
    DisposableAttach.DisposableAttach,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["hub.machine_attach"]));

const MachineReissueTool = Tool.make(agentSurfaceRegistry["hub.machine_reissue"].name, {
  description: agentSurfaceRegistry["hub.machine_reissue"].description,
  parameters: HubMachineReissueInput,
  success: HubMachineStatus,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    Profiles.PermissionProfiles,
    ThreadManagementService.ThreadManagementService,
    DisposableAttach.DisposableAttach,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["hub.machine_reissue"]));

const MachineListTool = Tool.make(agentSurfaceRegistry["hub.machine_list"].name, {
  description: agentSurfaceRegistry["hub.machine_list"].description,
  parameters: HubMachineListInput,
  success: HubMachineList,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    Profiles.PermissionProfiles,
    DisposableAttach.DisposableAttach,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["hub.machine_list"]));

export const HostStatusToolkit = Toolkit.make(
  ProcessHistoryTool,
  ResourceHistoryTool,
  HostStatusTool,
  VerifyTool,
  membershipTool("hub.device_join"),
  membershipTool("hub.device_leave"),
  membershipTool("hub.device_repair"),
  MoveTool,
  RoutesTool,
  RoutesUpdateTool,
  ChildPrepareTool,
  ChildConnectionTool,
  ChildStatusTool,
  DeviceSetupTool,
  OpenCodexSyncTool,
  MachineAttachTool,
  MachineReissueTool,
  MachineListTool,
);
