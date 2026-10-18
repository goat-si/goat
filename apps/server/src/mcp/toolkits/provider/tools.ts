import * as HomeRequests from "../../../provider/CodexHomeRequests.ts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import {
  OrchestratorMcpFailure,
  ProviderHomeRequestInput,
  ProviderHomeRequestResultJson,
  ProviderDiagnoseOnHostInput,
  ProviderDiagnoseOnHostResult,
} from "@goat/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ProviderDiagnosisRouting from "../../../provider/ProviderDiagnosisRouting.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

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
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.diagnose"]));

const ProviderHomeRequestTool = Tool.make(agentSurfaceRegistry["provider.home_request"].name, {
  description: agentSurfaceRegistry["provider.home_request"].description,
  parameters: ProviderHomeRequestInput,
  success: ProviderHomeRequestResultJson,
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    HomeRequests.CodexHomeRequests,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["provider.home_request"]));
export const ProviderToolkit = Toolkit.make(ProviderDiagnoseTool, ProviderHomeRequestTool);
