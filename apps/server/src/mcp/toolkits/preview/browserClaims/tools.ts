import {
  BrowserClaimResult,
  BrowserClaimsSnapshot,
  BrowserOrigin,
  OrchestratorMcpFailure,
  PositiveInt,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { BrowserOriginGrants } from "../../../../preview/BrowserOriginGrantsLayer.ts";
import { agentSurfaceAnnotations } from "../../../agentSurface.ts";
import * as McpInvocationContext from "../../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../../orchestration-v2/ThreadManagementService.ts";

const input = Schema.Struct({
  pid: PositiveInt,
  windowId: PositiveInt,
  origin: BrowserOrigin,
});
export type BrowserClaimInput = typeof input.Type;
const RequestTool = Tool.make(agentSurfaceRegistry["browser_claim.request"].name, {
  description: agentSurfaceRegistry["browser_claim.request"].description,
  parameters: input,
  success: BrowserClaimResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    BrowserOriginGrants,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["browser_claim.request"]));
const ListTool = Tool.make(agentSurfaceRegistry["browser_claim.list"].name, {
  description: agentSurfaceRegistry["browser_claim.list"].description,
  parameters: Tool.EmptyParams,
  success: BrowserClaimsSnapshot,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    BrowserOriginGrants,
  ],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["browser_claim.list"]));
export const BrowserClaimToolkit = Toolkit.make(RequestTool, ListTool);
