import {
  NonNegativeInt,
  OrchestrationGetFullThreadDiffInput,
  OrchestratorMcpFailure,
  ThreadId,
} from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadDiffMcpService from "../../ThreadDiffMcpService.ts";

const ThreadDiffResult = Schema.Struct({
  threadId: Schema.String,
  fromTurnCount: Schema.Int,
  toTurnCount: Schema.Int,
  diff: Schema.String,
  truncated: Schema.Boolean.annotate({
    description: "True when diff was cut at 256 KiB; read a narrower turn range for the rest.",
  }),
});
const threadDiffDependencies = [
  McpInvocationContext.McpInvocationContext,
  ThreadDiffMcpService.ThreadDiffMcpService,
];

const ThreadTurnDiffTool = Tool.make(agentSurfaceRegistry["thread.turn_diff"].name, {
  description: agentSurfaceRegistry["thread.turn_diff"].description,
  // The contract's range check names its schema, which MCP inputs cannot take as their root;
  // ThreadDiffMcpService checks the range instead.
  parameters: Schema.Struct({
    threadId: ThreadId,
    fromTurnCount: NonNegativeInt,
    toTurnCount: NonNegativeInt,
    ignoreWhitespace: Schema.optionalKey(Schema.Boolean),
  }),
  success: ThreadDiffResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: threadDiffDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.turn_diff"]));

const ThreadFullDiffTool = Tool.make(agentSurfaceRegistry["thread.diff"].name, {
  description: agentSurfaceRegistry["thread.diff"].description,
  parameters: OrchestrationGetFullThreadDiffInput,
  success: ThreadDiffResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: threadDiffDependencies,
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["thread.diff"]));

export const ThreadDiffToolkit = Toolkit.make(ThreadTurnDiffTool, ThreadFullDiffTool);
