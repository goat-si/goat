import {
  AgentWorkspaceListInput,
  AgentWorkspaceListResult,
  AgentWorkspaceReadInput,
  AgentWorkspaceReadResult,
  AgentWorkspaceSearchInput,
  AgentWorkspaceSearchResult,
  OrchestratorMcpFailure,
  AgentWorkspaceWriteInput,
  AgentWorkspaceWriteResult,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { Tool, Toolkit } from "effect/ai";
import * as Service from "../../AgentWorkspaceMcpService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import { withClientRequestId } from "../keyedParameters.ts";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [Service.AgentWorkspaceMcpService, McpInvocationContext, ThreadManagementService],
};
const list = agentSurfaceRegistry["workspace.list"],
  read = agentSurfaceRegistry["workspace.read"],
  search = agentSurfaceRegistry["workspace.search"];
export const WorkspaceToolkit = Toolkit.make(
  Tool.make(agentSurfaceRegistry["workspace.write"].name, {
    ...shared,
    description: agentSurfaceRegistry["workspace.write"].description,
    parameters: withClientRequestId(AgentWorkspaceWriteInput),
    success: AgentWorkspaceWriteResult,
  }).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["workspace.write"])),
  Tool.make(list.name, {
    ...shared,
    description: list.description,
    parameters: AgentWorkspaceListInput,
    success: AgentWorkspaceListResult,
  }).annotateMerge(agentSurfaceAnnotations(list)),
  Tool.make(read.name, {
    ...shared,
    description: read.description,
    parameters: AgentWorkspaceReadInput,
    success: AgentWorkspaceReadResult,
  }).annotateMerge(agentSurfaceAnnotations(read)),
  Tool.make(search.name, {
    ...shared,
    description: search.description,
    parameters: AgentWorkspaceSearchInput,
    success: AgentWorkspaceSearchResult,
  }).annotateMerge(agentSurfaceAnnotations(search)),
);
