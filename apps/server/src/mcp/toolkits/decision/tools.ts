import { withClientRequestId } from "../keyedParameters.ts";
import {
  DecisionAnswerMcpInput,
  DecisionGetMcpInput,
  DecisionItem,
  DecisionListMcpInput,
  DecisionListResult,
  DecisionRequestInput,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { Tool, Toolkit } from "effect/ai";
import * as DecisionService from "../../../goatclaw/DecisionService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
    DecisionService.DecisionService,
  ],
};
const list = Tool.make("goat_decision_list", {
  ...shared,
  description: agentSurfaceRegistry["decision.list"].description,
  parameters: DecisionListMcpInput,
  success: DecisionListResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["decision.list"]));
const get = Tool.make("goat_decision_get", {
  ...shared,
  description: agentSurfaceRegistry["decision.read"].description,
  parameters: DecisionGetMcpInput,
  success: DecisionItem,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["decision.read"]));
const request = Tool.make("goat_decision_request", {
  ...shared,
  description: agentSurfaceRegistry["decision.request"].description,
  parameters: withClientRequestId(DecisionRequestInput),
  success: DecisionItem,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["decision.request"]));
const answer = Tool.make("goat_decision_answer", {
  ...shared,
  description: agentSurfaceRegistry["decision.answer"].description,
  parameters: DecisionAnswerMcpInput,
  success: DecisionItem,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["decision.answer"]));
export const DecisionToolkit = Toolkit.make(list, get, request, answer);
