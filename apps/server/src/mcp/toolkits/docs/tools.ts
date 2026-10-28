import { OrchestratorMcpFailure } from "@goat/contracts";
import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as UserDocs from "../../../userDocs/UserDocs.ts";
import { agentSurfaceAnnotations } from "../../agentSurface.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [UserDocs.UserDocs],
};

const DocsSearchTool = Tool.make(agentSurfaceRegistry["docs.search"].name, {
  ...shared,
  description: agentSurfaceRegistry["docs.search"].description,
  parameters: Schema.Struct({
    query: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
    limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 }))),
  }),
  success: Schema.Struct({
    build: Schema.String,
    words: Schema.Array(Schema.String),
    matches: Schema.Array(
      Schema.Struct({
        page: Schema.String,
        title: Schema.String,
        /** null for the page's text before its first section. */
        heading: Schema.NullOr(Schema.String),
        url: Schema.String,
        snippet: Schema.String,
        matchedWords: Schema.Array(Schema.String),
      }),
    ),
    total: Schema.Int,
    truncated: Schema.Boolean,
  }),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["docs.search"]));

const Guide = Schema.Struct({ page: Schema.String, title: Schema.String, url: Schema.String });

const DocsReadTool = Tool.make(agentSurfaceRegistry["docs.read"].name, {
  ...shared,
  description: agentSurfaceRegistry["docs.read"].description,
  parameters: Schema.Struct({
    page: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
    section: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(300))),
    cursor: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(200))),
  }),
  success: Schema.Union([
    Schema.Struct({ build: Schema.String, guides: Schema.Array(Guide) }),
    Schema.Struct({
      build: Schema.String,
      page: Schema.String,
      title: Schema.String,
      heading: Schema.NullOr(Schema.String),
      url: Schema.String,
      markdown: Schema.String,
      sections: Schema.Array(
        Schema.Struct({
          heading: Schema.String,
          depth: Schema.Literals([2, 3]),
          url: Schema.String,
        }),
      ),
      truncated: Schema.Boolean,
      nextCursor: Schema.NullOr(Schema.String),
    }),
  ]),
}).annotateMerge(agentSurfaceAnnotations(agentSurfaceRegistry["docs.read"]));

export const DocsToolkit = Toolkit.make(DocsSearchTool, DocsReadTool);
