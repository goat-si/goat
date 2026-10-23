import {
  DecisionAnswerInput,
  DecisionGetInput,
  DecisionItem,
  DecisionListInput,
  DecisionListResult,
  DecisionRequestInput,
  OrchestratorMcpFailure,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { Tool, Toolkit } from "effect/ai";
import * as DecisionInbox from "../../../goatclaw/DecisionInbox.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagement.ThreadManagementService,
    DecisionInbox.DecisionInbox,
  ],
};
const list = Tool.make("goat_decision_list", {
  ...shared,
  description: agentSurfaceRegistry["decision.list"].description,
  parameters: DecisionListInput,
  success: DecisionListResult,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["decision.list"]));
const get = Tool.make("goat_decision_get", {
  ...shared,
  description: agentSurfaceRegistry["decision.read"].description,
  parameters: DecisionGetInput,
  success: DecisionItem,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["decision.read"]));
const request = Tool.make("goat_decision_request", {
  ...shared,
  description: agentSurfaceRegistry["decision.request"].description,
  parameters: DecisionRequestInput,
  success: DecisionItem,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["decision.request"]));
const answer = Tool.make("goat_decision_answer", {
  ...shared,
  description: agentSurfaceRegistry["decision.answer"].description,
  parameters: DecisionAnswerInput,
  success: DecisionItem,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["decision.answer"]));
export const DecisionToolkit = Toolkit.make(list, get, request, answer);
