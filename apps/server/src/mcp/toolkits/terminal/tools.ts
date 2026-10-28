import {
  AgentTerminalEmptyInput,
  AgentTerminalHandleInput,
  AgentTerminalReadInput,
  AgentTerminalWriteInput,
  AgentTerminalReadResult,
  AgentTerminalResult,
  AgentTerminalListResult,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { Tool, Toolkit } from "effect/ai";
import { ThreadManagementService } from "../../../orchestration-v2/ThreadManagementService.ts";
import { AgentTerminalMcpService } from "../../AgentTerminalMcpService.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import { withClientRequestId } from "../keyedParameters.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [AgentTerminalMcpService, McpInvocationContext, ThreadManagementService],
};
const entries = agentSurfaceRegistry;
export const TerminalToolkit = Toolkit.make(
  Tool.make(entries["terminal.list"].name, {
    ...shared,
    description: entries["terminal.list"].description,
    success: AgentTerminalListResult,
  }).annotateMerge(agentSurfaceAnnotations(entries["terminal.list"])),
  Tool.make(entries["terminal.read"].name, {
    ...shared,
    description: entries["terminal.read"].description,
    parameters: AgentTerminalReadInput,
    success: AgentTerminalReadResult,
  }).annotateMerge(agentSurfaceAnnotations(entries["terminal.read"])),
  Tool.make(entries["terminal.open"].name, {
    ...shared,
    description: entries["terminal.open"].description,
    parameters: withClientRequestId(AgentTerminalEmptyInput),
    success: AgentTerminalResult,
  }).annotateMerge(agentSurfaceAnnotations(entries["terminal.open"])),
  Tool.make(entries["terminal.write"].name, {
    ...shared,
    description: entries["terminal.write"].description,
    parameters: withClientRequestId(AgentTerminalWriteInput),
    success: AgentTerminalResult,
  }).annotateMerge(agentSurfaceAnnotations(entries["terminal.write"])),
  Tool.make(entries["terminal.clear"].name, {
    ...shared,
    description: entries["terminal.clear"].description,
    parameters: withClientRequestId(AgentTerminalHandleInput),
    success: AgentTerminalResult,
  }).annotateMerge(agentSurfaceAnnotations(entries["terminal.clear"])),
  Tool.make(entries["terminal.restart"].name, {
    ...shared,
    description: entries["terminal.restart"].description,
    parameters: withClientRequestId(AgentTerminalHandleInput),
    success: AgentTerminalResult,
  }).annotateMerge(agentSurfaceAnnotations(entries["terminal.restart"])),
  Tool.make(entries["terminal.close"].name, {
    ...shared,
    description: entries["terminal.close"].description,
    parameters: withClientRequestId(AgentTerminalHandleInput),
    success: AgentTerminalResult,
  }).annotateMerge(agentSurfaceAnnotations(entries["terminal.close"])),
);
