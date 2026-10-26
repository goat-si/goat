import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import {
  ComputerUseRequestInput,
  ComputerUseRequestResult,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ComputerUseLeases from "../../../cua/ComputerUseLeases.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as Handoffs from "../../../handoffs/Handoffs.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const entry = agentSurfaceRegistry["computer_use.request"];

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

export const ComputerUseToolkit = Toolkit.make(RequestTool);
