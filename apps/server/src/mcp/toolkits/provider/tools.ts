import * as HomeRequests from "../../../provider/CodexHomeRequests.ts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import {
  CloudHoldersInput,
  CloudHoldersResult,
  CloudLaunchInput,
  CloudLaunchMcpResult,
  CloudRunForgetInput,
  CloudRunForgetResult,
  CloudRunListInput,
  CloudRunListResult,
  CloudRunRegisterInput,
  CloudRunRegisterResult,
  OrchestratorMcpFailure,
  ProviderAddableListResult,
  ProviderHomeRequestInput,
  ProviderHomeRequestResultJson,
  ProviderDiagnoseOnHostInput,
  ProviderDiagnoseOnHostResult,
  ProviderHostMatrixInput,
  ProviderHostMatrixResult,
  ProviderSyncCancelInput,
  ProviderSyncInput,
  ProviderSyncResultJson,
  ProviderSyncState,
  ProviderSyncStatusInput,
  ProviderLoginFlowInput,
  ProviderLoginResultJson,
  ProviderLoginFlowResultJson,
  ProviderLoginStartInput,
  ProviderSetupOpenInput,
  ProviderSetupOpenResultJson,
  ProviderAddInput,
  ProviderLinkInput,
  ProviderManageResultJson,
  ProviderRemoveInput,
  ProviderUpdateInput,
} from "@goat/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as CloudAgents from "../../../cloudAgents/CloudAgentService.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderDiagnosisRouting from "../../../provider/ProviderDiagnosisRouting.ts";
import * as ProviderHostSync from "../../../provider/ProviderHostSync.ts";
import * as ProviderOnboarding from "../../../provider/ProviderOnboarding.ts";
import * as ProviderSettings from "../../../provider/ProviderSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { withClientRequestId } from "../keyedParameters.ts";

const ProviderDiagnoseTool = Tool.make(agentSurfaceRegistry["provider.diagnose"].name, {
  description: agentSurfaceRegistry["provider.diagnose"].description,
  parameters: ProviderDiagnoseOnHostInput,
  success: ProviderDiagnoseOnHostResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProviderDiagnosisRouting.ProviderDiagnosisRouting,
    ProviderSettings.ProviderSettings,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.diagnose"]));

const ProviderHomeRequestTool = Tool.make(agentSurfaceRegistry["provider.home_request"].name, {
  description: agentSurfaceRegistry["provider.home_request"].description,
  parameters: withClientRequestId(ProviderHomeRequestInput),
  success: ProviderHomeRequestResultJson,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HomeRequests.CodexHomeRequests,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.home_request"]));

const hostSyncDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ProviderHostSync.ProviderHostSync,
];
const ProviderHostMatrixTool = Tool.make(agentSurfaceRegistry["provider.host_matrix"].name, {
  description: agentSurfaceRegistry["provider.host_matrix"].description,
  parameters: ProviderHostMatrixInput,
  success: ProviderHostMatrixResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: hostSyncDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.host_matrix"]));
const ProviderSyncTool = Tool.make(agentSurfaceRegistry["provider.sync"].name, {
  description: agentSurfaceRegistry["provider.sync"].description,
  parameters: withClientRequestId(ProviderSyncInput),
  success: ProviderSyncResultJson,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: hostSyncDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.sync"]));
const ProviderSyncStatusTool = Tool.make(agentSurfaceRegistry["provider.sync_read"].name, {
  description: agentSurfaceRegistry["provider.sync_read"].description,
  parameters: ProviderSyncStatusInput,
  success: ProviderSyncState,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: hostSyncDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.sync_read"]));
const ProviderSyncCancelTool = Tool.make(agentSurfaceRegistry["provider.sync_cancel"].name, {
  description: agentSurfaceRegistry["provider.sync_cancel"].description,
  parameters: ProviderSyncCancelInput,
  success: ProviderSyncState,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: hostSyncDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.sync_cancel"]));
const onboardingDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadManagementService.ThreadManagementService,
  ProviderOnboarding.ProviderOnboarding,
];

const ProviderAddableListTool = Tool.make(agentSurfaceRegistry["provider.addable_list"].name, {
  description: agentSurfaceRegistry["provider.addable_list"].description,
  parameters: Tool.EmptyParams,
  success: ProviderAddableListResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: onboardingDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.addable_list"]));
const ProviderSetupOpenTool = Tool.make(agentSurfaceRegistry["provider.setup_open"].name, {
  description: agentSurfaceRegistry["provider.setup_open"].description,
  parameters: withClientRequestId(ProviderSetupOpenInput),
  success: ProviderSetupOpenResultJson,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: onboardingDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.setup_open"]));
const ProviderLoginStartTool = Tool.make(agentSurfaceRegistry["provider.login_start"].name, {
  description: agentSurfaceRegistry["provider.login_start"].description,
  parameters: withClientRequestId(ProviderLoginStartInput),
  success: ProviderLoginResultJson,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: onboardingDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.login_start"]));
const ProviderLoginStatusTool = Tool.make(agentSurfaceRegistry["provider.login_status"].name, {
  description: agentSurfaceRegistry["provider.login_status"].description,
  parameters: ProviderLoginFlowInput,
  success: ProviderLoginFlowResultJson,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: onboardingDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.login_status"]));
const ProviderLoginCancelTool = Tool.make(agentSurfaceRegistry["provider.login_cancel"].name, {
  description: agentSurfaceRegistry["provider.login_cancel"].description,
  parameters: ProviderLoginFlowInput,
  success: ProviderLoginFlowResultJson,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: onboardingDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.login_cancel"]));
const settingsTool = {
  success: ProviderManageResultJson,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ProviderSettings.ProviderSettings,
  ],
};
const ProviderUpdateTool = Tool.make(agentSurfaceRegistry["provider.update"].name, {
  ...settingsTool,
  description: agentSurfaceRegistry["provider.update"].description,
  parameters: withClientRequestId(ProviderUpdateInput),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.update"]));
const ProviderAddTool = Tool.make(agentSurfaceRegistry["provider.add"].name, {
  ...settingsTool,
  description: agentSurfaceRegistry["provider.add"].description,
  parameters: withClientRequestId(ProviderAddInput),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.add"]));
const ProviderLinkTool = Tool.make(agentSurfaceRegistry["provider.link"].name, {
  ...settingsTool,
  description: agentSurfaceRegistry["provider.link"].description,
  parameters: withClientRequestId(ProviderLinkInput),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.link"]));
const ProviderRemoveTool = Tool.make(agentSurfaceRegistry["provider.remove"].name, {
  ...settingsTool,
  description: agentSurfaceRegistry["provider.remove"].description,
  parameters: withClientRequestId(ProviderRemoveInput),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.remove"]));
const cloudTool = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    CloudAgents.CloudAgentService,
  ],
};

const CloudHoldersTool = Tool.make(agentSurfaceRegistry["cloud_agent.holders"].name, {
  ...cloudTool,
  description: agentSurfaceRegistry["cloud_agent.holders"].description,
  parameters: CloudHoldersInput,
  success: CloudHoldersResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["cloud_agent.holders"]));

const CloudLaunchTool = Tool.make(agentSurfaceRegistry["cloud_agent.launch"].name, {
  ...cloudTool,
  description: agentSurfaceRegistry["cloud_agent.launch"].description,
  parameters: withClientRequestId(CloudLaunchInput),
  success: CloudLaunchMcpResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["cloud_agent.launch"]));

const CloudRunRegisterTool = Tool.make(agentSurfaceRegistry["cloud_agent.run_register"].name, {
  ...cloudTool,
  description: agentSurfaceRegistry["cloud_agent.run_register"].description,
  parameters: CloudRunRegisterInput,
  success: CloudRunRegisterResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["cloud_agent.run_register"]));

const CloudRunListTool = Tool.make(agentSurfaceRegistry["cloud_agent.run_list"].name, {
  ...cloudTool,
  description: agentSurfaceRegistry["cloud_agent.run_list"].description,
  parameters: CloudRunListInput,
  success: CloudRunListResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["cloud_agent.run_list"]));

const CloudRunForgetTool = Tool.make(agentSurfaceRegistry["cloud_agent.run_forget"].name, {
  ...cloudTool,
  description: agentSurfaceRegistry["cloud_agent.run_forget"].description,
  parameters: CloudRunForgetInput,
  success: CloudRunForgetResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["cloud_agent.run_forget"]));

export const ProviderToolkit = Toolkit.make(
  ProviderDiagnoseTool,
  ProviderHomeRequestTool,
  ProviderHostMatrixTool,
  ProviderSyncTool,
  ProviderSyncStatusTool,
  ProviderSyncCancelTool,
  ProviderAddableListTool,
  ProviderSetupOpenTool,
  ProviderLoginStartTool,
  ProviderLoginStatusTool,
  ProviderLoginCancelTool,
  ProviderUpdateTool,
  ProviderAddTool,
  ProviderLinkTool,
  ProviderRemoveTool,
  CloudHoldersTool,
  CloudLaunchTool,
  CloudRunRegisterTool,
  CloudRunListTool,
  CloudRunForgetTool,
);
