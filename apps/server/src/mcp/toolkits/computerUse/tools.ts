import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import {
  ComputerUseRequestInput,
  ComputerUseRequestResult,
  ComputerUseUpdateInput,
  ComputerUseUpdateResult,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ComputerUseLeases from "../../../cua/ComputerUseLeases.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as Handoffs from "../../../handoffs/Handoffs.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const entry = agentSurfaceRegistry["computer_use.request"];
const updateEntry = agentSurfaceRegistry["computer_use.update"];

const UpdateTool = Tool.make(updateEntry.name, {
  description: updateEntry.description,
  parameters: ComputerUseUpdateInput,
  success: ComputerUseUpdateResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ServerConfig.ServerConfig,
    ServerSettings.ServerSettingsService,
    ThreadManagementService.ThreadManagementService,
  ],
}).annotateMerge(agentSurfaceAnnotations(updateEntry));

const RequestTool = Tool.make(entry.name, {
  description: entry.description,
  parameters: ComputerUseRequestInput,
  success: ComputerUseRequestResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    Handoffs.Handoffs,
    ComputerUseLeases.ComputerUseLeases,
    ServerEnvironment.ServerEnvironment,
  ],
}).annotateMerge(agentSurfaceAnnotations(entry));

export const ComputerUseToolkit = Toolkit.make(RequestTool, UpdateTool);
