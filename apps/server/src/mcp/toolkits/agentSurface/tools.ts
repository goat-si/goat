import { OrchestratorMcpFailure } from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { AgentSurfaceResult } from "@goat/contracts/agentSurface/envelope";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const Effect = Schema.Literals(["read", "write", "destructive"]);
const Availability = Schema.Struct({
  now: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
});
const EntrySummary = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  summary: Schema.String,
  effect: Effect,
  available: Availability,
});

export const DescribeResult = Schema.Union([
  Schema.Struct({
    depth: Schema.Literal("surface"),
    /** Changes whenever the registry does, so clients and prompt caches can tell. */
    surfaceVersion: Schema.String,
    resources: Schema.Array(
      Schema.Struct({ resource: Schema.String, verbs: Schema.Array(Schema.String) }),
    ),
    next: Schema.String,
  }),
  Schema.Struct({
    depth: Schema.Literal("resource"),
    resource: Schema.String,
    entries: Schema.Array(EntrySummary),
  }),
  Schema.Struct({
    depth: Schema.Literal("path"),
    entry: Schema.Struct({
      ...EntrySummary.fields,
      canonicalName: Schema.String,
      legacyNames: Schema.Array(Schema.String),
      description: Schema.String,
      hostRoutable: Schema.Boolean,
      requires: Schema.Literals(["thread", "client", "either"]),
      dryRun: Schema.Literals(["supported", "unsupported"]),
      humanSteps: Schema.Array(Schema.String),
      inputSchema: Schema.Unknown,
      outputSchema: Schema.NullOr(Schema.Unknown),
    }),
  }),
]);
export type DescribeResult = typeof DescribeResult.Type;

const DescribeTool = Tool.make(agentSurfaceRegistry["surface.describe"].name, {
  description: agentSurfaceRegistry["surface.describe"].description,
  parameters: Schema.Struct({
    path: Schema.optional(
      Schema.String.annotate({
        description:
          'A resource ("thread"), a path ("thread.send"), or a tool name. Omit to list resources.',
      }),
    ),
  }),
  success: DescribeResult,
  failure: OrchestratorMcpFailure,
  dependencies: [McpInvocationContext.McpInvocationContext],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["surface.describe"]));

const CallTool = Tool.make(agentSurfaceRegistry["surface.call"].name, {
  description: agentSurfaceRegistry["surface.call"].description,
  parameters: Schema.Struct({
    path: Schema.String.check(Schema.isMinLength(1)).annotate({
      description: 'Path such as "thread.read", or a tool name.',
    }),
    args: Schema.optional(
      Schema.Record(Schema.String, Schema.Unknown).annotate({
        description: "The tool's own arguments. Defaults to {}.",
      }),
    ),
  }),
  success: AgentSurfaceResult,
  failure: OrchestratorMcpFailure,
  // The request's own client: the MCP layer replaces the registration-time one per call.
  dependencies: [McpInvocationContext.McpInvocationContext, McpSchema.McpServerClient],
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["surface.call"]));

export const AgentSurfaceToolkit = Toolkit.make(DescribeTool, CallTool);
