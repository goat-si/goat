import {
  AgentWorkspaceListInput,
  AgentWorkspaceListResult,
  AgentWorkspaceReadInput,
  AgentWorkspaceReadResult,
  AgentWorkspaceSearchInput,
  AgentWorkspaceSearchResult,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { Tool, Toolkit } from "effect/ai";
import * as Service from "../../AgentWorkspaceMcpService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [Service.AgentWorkspaceMcpService, McpInvocationContext],
};
const list = agentSurfaceRegistry["workspace.list"],
  read = agentSurfaceRegistry["workspace.read"],
  search = agentSurfaceRegistry["workspace.search"];
export const WorkspaceToolkit = Toolkit.make(
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
