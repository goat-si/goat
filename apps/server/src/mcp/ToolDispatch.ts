import { agentSurfaceRegistry } from "@goat/contracts/agentSurface";
import { legacyToolNameTargets, listedToolName } from "@goat/contracts/agentSurface/resolve";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { McpSchema } from "effect/ai";
import { HttpServerRequest } from "effect/http";

const isInvalidParams = Schema.is(McpSchema.InvalidParams);
const isInternalError = Schema.is(McpSchema.InternalError);

/** `callTool` may fail with any MCP error; dispatch callers handle the two it names. */
export const dispatchError = (
  error: McpSchema.InvalidParams | McpSchema.InternalError | McpSchema.McpErrorBase,
) =>
  isInvalidParams(error) || isInternalError(error)
    ? error
    : new McpSchema.InternalError({ message: error.message });

/**
 * The client a nested call runs as. A stateful request carries its own `McpServerClient`. A
 * 2026-07-28 request has no session, so Effect provides only `McpRequestContext`, yet
 * `McpServer.callTool` still reads an `McpServerClient`; this one is built from the request and
 * has no reverse channel, which no GOAT tool uses.
 */
const nestedCallClient = Effect.gen(function* () {
  const client = yield* Effect.serviceOption(McpSchema.McpServerClient);
  if (Option.isSome(client)) return client.value;
  const request = yield* Effect.serviceOption(McpSchema.McpRequestContext);
  if (Option.isNone(request)) {
    return yield* Effect.die(new Error("Nested MCP tool call outside an MCP request"));
  }
  const { clientId, clientCapabilities, requestMetadata } = request.value;
  // Effect types this field as a stateful version; the nested call keeps the request's own.
  const protocolVersion = request.value
    .protocolVersion as McpSchema.McpServerClient["Service"]["protocolVersion"];
  const clientInfo = request.value.clientInfo ?? { name: "unknown", version: "unknown" };
  return McpSchema.McpServerClient.of({
    clientId,
    protocolVersion,
    clientCapabilities,
    clientInfo,
    // Effect reads a nested call's request metadata from here, as for a stateful session.
    initializePayload: {
      protocolVersion,
      capabilities: clientCapabilities,
      clientInfo,
      ...(requestMetadata === undefined ? {} : { _meta: requestMetadata }),
    },
    requestMetadata,
    getClient: Effect.die(new Error(`MCP ${protocolVersion} has no server-to-client channel`)),
  });
});

/**
 * Runs a nested `McpServer.callTool` as the request's own client, failing with the two errors
 * dispatch callers handle.
 */
export const asNestedCall = <A>(
  callTool: Effect.Effect<
    A,
    McpSchema.InvalidParams | McpSchema.InternalError | McpSchema.McpErrorBase,
    McpSchema.McpServerClient
  >,
) =>
  Effect.flatMap(nestedCallClient, (client) =>
    Effect.provideService(callTool, McpSchema.McpServerClient, client),
  ).pipe(Effect.mapError(dispatchError));

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

/** The tools/call in this /mcp request named a tool by a shipped name it is no longer listed under. */
class LegacyToolCall extends Context.Service<
  LegacyToolCall,
  { readonly legacy: string; readonly listed: string }
>()("goat/mcp/ToolDispatch/LegacyToolCall") {}

/** Where a result names the listed tool to call instead; namespaced as MCP asks of _meta keys. */
export const DEPRECATED_META_KEY = "goat/deprecated";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The JSON-RPC body with a legacy tool name in tools/call replaced by the name the tool is listed
 * under, or undefined when the body calls no legacy name. Every other body, malformed ones
 * included, stays for the MCP server to answer.
 */
export const listedToolCall = (
  body: string,
): { readonly body: string; readonly legacy: string; readonly listed: string } | undefined => {
  if (!body.includes("tools/call")) return undefined;
  const message = Option.getOrUndefined(decodeJson(body));
  if (!isRecord(message) || message.method !== "tools/call" || !isRecord(message.params))
    return undefined;
  const name = message.params.name;
  const listed = typeof name === "string" ? legacyToolNameTargets.get(name) : undefined;
  if (typeof name !== "string" || listed === undefined) return undefined;
  const params = { ...message.params, name: listed };
  return { body: encodeJson({ ...message, params }), legacy: name, listed };
};

/**
 * Resolves a legacy tool name to the listed one before Effect's MCP core sees the request, since
 * one visibility check guards both tools/list and tools/call. The call keeps its argument
 * refusal, access checks and analytics. The Mcp-Name header 2026-07-28 callers send is not
 * rewritten yet, so a legacy name over that protocol is still refused.
 */
export const withServedToolNames =
  /* The auth middleware's span already covers each request. */
  Effect.fnUntraced(function* <A, E, R>(httpEffect: Effect.Effect<A, E, R>) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== "POST") return yield* httpEffect;
    // The body is read once and cached, so the MCP server reads this same text afterwards.
    const body = yield* Effect.option(request.text);
    const call = Option.isSome(body) ? listedToolCall(body.value) : undefined;
    if (call === undefined) return yield* httpEffect;
    // Inherits everything else, including the source that response handlers are keyed by.
    const resolved: HttpServerRequest.HttpServerRequest = Object.create(request, {
      text: { value: Effect.succeed(call.body) },
    });
    return yield* httpEffect.pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, resolved),
      Effect.provideService(LegacyToolCall, { legacy: call.legacy, listed: call.listed }),
    );
  });

const listedNames: ReadonlyMap<string, string> = new Map(
  Object.values(agentSurfaceRegistry).map((entry) => [entry.name, listedToolName(entry)]),
);

/** The name /mcp registers a tool under, given the name it shipped with or the listed one. */
export const registeredToolName = (name: string) => listedNames.get(name) ?? name;

/** Adds the deprecation to a result when this request named the tool by a legacy name. */
const markDeprecated = (listed: string) =>
  Effect.fnUntraced(function* (result: McpSchema.CallToolResult | McpSchema.InputRequired) {
    const call = yield* Effect.serviceOption(LegacyToolCall);
    if (Option.isNone(call) || call.value.listed !== listed) return result;
    // A call that asks for input is answered by its retry, which carries the same name.
    if (result instanceof McpSchema.InputRequired) return result;
    return new McpSchema.CallToolResult({
      ...result,
      _meta: { ...result._meta, [DEPRECATED_META_KEY]: listed },
    });
  });

type ToolResult = McpSchema.CallToolResult | McpSchema.InputRequired;

/**
 * A registration listed under its registry entry's canonical name
 * (docs/internals/agent-surface.md#names). McpHttpServer applies it last, so access declarations,
 * capability checks and analytics keep keying by the shipped name the toolkit registers, and a
 * caller passes the same checks under either name.
 */
export const listedRegistration = <
  P,
  E,
  R,
  Registration extends {
    readonly tool: McpSchema.Tool;
    readonly handle: (payload: P) => Effect.Effect<ToolResult, E, R>;
  },
>(
  registration: Registration,
): Registration => {
  const listed = listedNames.get(registration.tool.name);
  if (listed === undefined || listed === registration.tool.name) return registration;
  return {
    ...registration,
    tool: new McpSchema.Tool({ ...registration.tool, name: listed }),
    handle: (payload: P) =>
      registration.handle(payload).pipe(Effect.flatMap(markDeprecated(listed))),
  };
};
