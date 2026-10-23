import { OrchestratorMcpFailure } from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { AgentSurfaceResult } from "@goat/contracts/agentSurface/envelope";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import { agentSurfaceAnnotations } from "../../agentSurface.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { OperationCancelTool, OperationReadTool, OperationWaitTool } from "./operations.ts";

const Effect = Schema.Literals(["read", "write", "destructive"]);
const Availability = Schema.Struct({
  now: Schema.Boolean,
  reason: Schema.optionalKey(Schema.String),
});
const Requires = Schema.Literals(["thread", "client", "either"]);
/** At detail "names" only path, name and summary; "summary" adds the rest. */
const EntrySummary = Schema.Struct({
  path: Schema.String,
  name: Schema.String,
  summary: Schema.String,
  effect: Schema.optionalKey(Effect),
  requires: Schema.optionalKey(Requires),
  available: Schema.optionalKey(Availability),
  description: Schema.optionalKey(Schema.String),
});
const SearchMatch = Schema.Struct({
  ...EntrySummary.fields,
  /** exact: the query named it; all: it has every word; partial: only matchedWords. */
  match: Schema.Literals(["exact", "all", "partial"]),
  matchedWords: Schema.optionalKey(Schema.Array(Schema.String)),
  unmatchedWords: Schema.optionalKey(Schema.Array(Schema.String)),
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
    depth: Schema.Literal("search"),
    surfaceVersion: Schema.String,
    query: Schema.String,
    /** all: some path has every word; partial: paths share only some; none: no word matched. */
    mode: Schema.Literals(["all", "partial", "none"]),
    entries: Schema.Array(SearchMatch),
    /** Every path that matched, across pages. */
    total: Schema.Int,
    returned: Schema.Int,
    /** More matches follow; pass nextCursor with the same query for them. */
    truncated: Schema.Boolean,
    nextCursor: Schema.optionalKey(Schema.String),
    /** What was searched, and how many matches this caller cannot use now. */
    coverage: Schema.Struct({
      fields: Schema.Array(Schema.String),
      resources: Schema.String,
      searched: Schema.Int,
      ignoredWords: Schema.Array(Schema.String),
      notServed: Schema.Int,
      unavailableToCaller: Schema.Int,
    }),
    /** With no match: the paths spelled closest to the query. */
    nearest: Schema.optionalKey(Schema.Array(Schema.String)),
    next: Schema.optionalKey(Schema.String),
  }),
  Schema.Struct({
    depth: Schema.Literal("path"),
    entry: Schema.Struct({
      path: Schema.String,
      name: Schema.String,
      summary: Schema.String,
      effect: Effect,
      available: Availability,
      canonicalName: Schema.String,
      legacyNames: Schema.Array(Schema.String),
      description: Schema.String,
      /** Guidance longer than the listed description, for this path only. */
      guide: Schema.optionalKey(Schema.String),
      hostRoutable: Schema.Boolean,
      requires: Requires,
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
    query: Schema.optional(
      Schema.String.check(Schema.isMinLength(1)).annotate({
        description:
          "Words or a tool name to find paths by. With a resource as path, searches only that resource.",
      }),
    ),
    detail: Schema.optional(
      Schema.Literals(["names", "summary", "full"]).annotate({
        description:
          "names: path, name, summary. summary (default): adds effect, availability and description. full: one path with its schemas and guide.",
      }),
    ),
    limit: Schema.optional(
      Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 50 })).annotate({
        description: "Search results per page, 1-50. Defaults to 10.",
      }),
    ),
    cursor: Schema.optional(
      Schema.String.annotate({ description: "nextCursor from the previous page of this search." }),
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

export const AgentSurfaceToolkit = Toolkit.make(
  DescribeTool,
  CallTool,
  OperationReadTool,
  OperationWaitTool,
  OperationCancelTool,
);
