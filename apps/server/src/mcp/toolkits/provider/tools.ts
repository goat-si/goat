import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import {
  OrchestratorMcpFailure,
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

export const ProviderToolkit = Toolkit.make(ProviderDiagnoseTool);
