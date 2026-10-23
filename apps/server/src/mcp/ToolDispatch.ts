import { canonicalToolAliases } from "@goat/contracts/agentSurface/resolve";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type { McpSchema } from "effect/ai";
import { HttpServerRequest } from "effect/http";

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

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The JSON-RPC body with a canonical tool name in tools/call replaced by the name that tool is
 * served under, or undefined when the body calls no canonical alias. Every other body, malformed
 * ones included, stays for the MCP server to answer.
 */
export const servedToolCallBody = (body: string): string | undefined => {
  if (!body.includes("tools/call")) return undefined;
  const message = Option.getOrUndefined(decodeJson(body));
  if (!isRecord(message) || message.method !== "tools/call" || !isRecord(message.params))
    return undefined;
  const name = message.params.name;
  const served = typeof name === "string" ? canonicalToolAliases.get(name) : undefined;
  return served === undefined
    ? undefined
    : encodeJson({ ...message, params: { ...message.params, name: served } });
};

/**
 * Runs an authenticated /mcp request with a canonical tool name resolved to the served one, so
 * the call reaches the registered handle with its argument refusal, access checks and analytics,
 * which record the served name. Effect's MCP core guards tools/list and tools/call with one
 * visibility check, so a tool cannot be hidden from the list and still be callable; the name is
 * resolved before the core sees it instead. A protocol that routes on an Mcp-Name header would
 * need that header rewritten too; /mcp serves 2025-06-18, which has none.
 */
export const withServedToolNames =
  /* The auth middleware's span already covers each request. */
  Effect.fnUntraced(function* <A, E, R>(httpEffect: Effect.Effect<A, E, R>) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== "POST") return yield* httpEffect;
    // The body is read once and cached, so the MCP server reads this same text afterwards.
    const body = yield* Effect.option(request.text);
    const served = Option.isSome(body) ? servedToolCallBody(body.value) : undefined;
    if (served === undefined) return yield* httpEffect;
    // Inherits everything else, including the source that response handlers are keyed by.
    const resolved: HttpServerRequest.HttpServerRequest = Object.create(request, {
      text: { value: Effect.succeed(served) },
    });
    return yield* httpEffect.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, resolved),
    );
  });
