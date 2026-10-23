import {
  ALWAYS_LOAD_META_KEY,
  type AgentToolListing,
  DEFAULT_AGENT_TOOL_LISTING,
} from "@goat/contracts/agentSurface/listing";
import { resolveAgentSurfaceEntry } from "@goat/contracts/agentSurface/resolve";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpBody, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as Settings from "../serverSettings.ts";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import { availability } from "./toolAvailability.ts";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The tools a caller is listed: none it cannot use, and in the core listing only entries the
 * registry lists as core. Core entries carry the always-load marker in both listings, so harnesses
 * that defer tools (Claude Code, Pi) keep them resident. Unlisted tools stay callable by name.
 */
const listedTools = (
  tools: ReadonlyArray<unknown>,
  scope: McpInvocationContext.McpInvocationScope,
  listing: AgentToolListing,
): ReadonlyArray<unknown> =>
  tools.flatMap((tool) => {
    if (!isRecord(tool) || typeof tool.name !== "string") return [tool];
    const entry = resolveAgentSurfaceEntry(tool.name);
    if (entry === undefined) return [tool];
    if (!availability(entry, scope, true).now) return [];
    const core = "listing" in entry && entry.listing === "core";
    if (listing === "core" && !core) return [];
    if (!core) return [tool];
    const meta = isRecord(tool._meta) ? tool._meta : {};
    return [{ ...tool, _meta: { ...meta, [ALWAYS_LOAD_META_KEY]: true } }];
  });

/** A JSON-RPC message with its tools/list result filtered; any other message unchanged. */
const filterMessage = (
  text: string,
  scope: McpInvocationContext.McpInvocationScope,
  listing: AgentToolListing,
) => {
  const message = Option.getOrUndefined(decodeJson(text));
  if (!isRecord(message) || !isRecord(message.result) || !Array.isArray(message.result.tools))
    return text;
  return encodeJson({
    ...message,
    result: { ...message.result, tools: listedTools(message.result.tools, scope, listing) },
  });
};

/** SSE text with each event's tools/list result filtered. */
const filterEvents = (
  text: string,
  scope: McpInvocationContext.McpInvocationScope,
  listing: AgentToolListing,
) =>
  text
    .split("\n")
    .map((line) =>
      line.startsWith("data:")
        ? `data: ${filterMessage(line.slice(5).trim(), scope, listing)}`
        : line,
    )
    .join("\n");

/**
 * The body of a response to tools/list, filtered whether it came as JSON or as SSE events, and
 * whether those were buffered or streamed: the content type says which, never the body's shape.
 */
export const filterToolsListBody = Effect.fnUntraced(function* (
  body: HttpBody.HttpBody,
  scope: McpInvocationContext.McpInvocationScope,
  listing: AgentToolListing,
) {
  if (body._tag !== "Uint8Array" && body._tag !== "Stream") return body;
  const text =
    body._tag === "Uint8Array"
      ? new TextDecoder().decode(body.body)
      : yield* body.stream.pipe(Stream.decodeText, Stream.mkString, Effect.orDie);
  const filtered = body.contentType.includes("text/event-stream")
    ? filterEvents(text, scope, listing)
    : filterMessage(text, scope, listing);
  return HttpBody.text(filtered, body.contentType);
});

/**
 * Filters tools/list by caller here, around Effect's MCP core: the core guards tools/list and
 * tools/call with one visibility check, so a tool it hid could not be called by name.
 */
export const withCallerListing = (listing: Effect.Effect<AgentToolListing>) =>
  /* The auth middleware's span already covers each request. */
  Effect.fnUntraced(function* <E, R>(
    httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== "POST") return yield* httpEffect;
    // The body is read once and cached, so the MCP server reads this same text afterwards.
    const body = yield* Effect.option(request.text);
    // A cheap guard only: JSON may escape the slash ("tools\/list"), so the decoded method decides.
    if (Option.isNone(body) || !body.value.includes("tools")) return yield* httpEffect;
    const call = Option.getOrUndefined(decodeJson(body.value));
    if (!isRecord(call) || call.method !== "tools/list") return yield* httpEffect;
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const mode = yield* listing;
    const response = yield* httpEffect;
    return HttpServerResponse.setBody(
      response,
      yield* filterToolsListBody(response.body, scope, mode),
    );
  });

/**
 * The listing the settings ask for. Unreadable settings list every tool: an agent then pays for
 * a longer listing, never loses a tool.
 */
export const listingSetting = (
  settings: Option.Option<Settings.ServerSettingsService["Service"]>,
): Effect.Effect<AgentToolListing> =>
  Option.isNone(settings)
    ? Effect.succeed(DEFAULT_AGENT_TOOL_LISTING)
    : settings.value.getSettings.pipe(
        Effect.map((current) => current.agentToolListing),
        Effect.catch((error) =>
          Effect.logWarning("listing every tool: settings unreadable", { error }).pipe(
            Effect.as("full" as const),
          ),
        ),
      );
