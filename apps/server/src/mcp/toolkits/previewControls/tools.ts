import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import {
  NonNegativeInt,
  OrchestratorMcpFailure,
  PreviewAutomationError,
  PreviewAutomationSignInState,
  PreviewAutomationSignInStateInput,
  PreviewListResult,
  PreviewRequestHandoffInput,
  PreviewRequestHandoffResult,
  PreviewTabId,
} from "@goat/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PreviewManager from "../../../preview/Manager.ts";
import * as PreviewHandoffs from "../../../preview/PreviewHandoffs.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: Schema.Union([PreviewAutomationError, OrchestratorMcpFailure]),
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PreviewManager.PreviewManager,
    PreviewAutomationBroker.PreviewAutomationBroker,
  ],
};
const PreviewListTool = Tool.make(agentSurfaceRegistry["preview.list"].name, {
  ...shared,
  description: agentSurfaceRegistry["preview.list"].description,
  parameters: Schema.Struct({
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 }))),
  }),
  success: Schema.Struct({
    ...PreviewListResult.fields,
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.list"]));
const PreviewCloseTool = Tool.make(agentSurfaceRegistry["preview.close"].name, {
  ...shared,
  description: agentSurfaceRegistry["preview.close"].description,
  parameters: Schema.Struct({ tabId: PreviewTabId }),
  success: Schema.Struct({}),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["preview.close"]));
const requestHandoff = agentSurfaceRegistry["preview.request_handoff"];
const PreviewRequestHandoffTool = Tool.make(requestHandoff.name, {
  description: requestHandoff.description,
  parameters: PreviewRequestHandoffInput,
  success: PreviewRequestHandoffResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    PreviewHandoffs.PreviewHandoffs,
  ],
}).annotateMerge(agentSurfaceAnnotations(requestHandoff));
const signInState = agentSurfaceRegistry["preview.sign_in_state"];
const PreviewSignInStateTool = Tool.make(signInState.name, {
  ...shared,
  description: signInState.description,
  parameters: PreviewAutomationSignInStateInput,
  success: PreviewAutomationSignInState,
}).annotateMerge(agentSurfaceAnnotations(signInState));
export const PreviewControlsToolkit = Toolkit.make(
  PreviewListTool,
  PreviewCloseTool,
  PreviewRequestHandoffTool,
  PreviewSignInStateTool,
);
