import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { McpSchema } from "effect/ai";

/**
 * Calls registered tools by name through the same handle /mcp serves, so each
 * call keeps its own argument refusal and McpToolAccess checks. McpHttpServer
 * builds it, since only it may hold Effect's McpServer.
 */
export class ToolDispatch extends Context.Service<
  ToolDispatch,
  {
    readonly call: (
      name: string,
      args: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<
      McpSchema.CallToolResult,
      McpSchema.InvalidParams | McpSchema.InternalError,
      McpSchema.McpServerClient
    >;
    readonly served: (
      name: string,
    ) => { readonly inputSchema: unknown; readonly outputSchema?: unknown } | undefined;
  }
>()("goat/mcp/ToolDispatch") {}
