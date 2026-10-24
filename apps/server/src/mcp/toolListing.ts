import {
  AGENT_TOOL_LISTING_HEADER,
  AGENT_TOOL_LISTING_META_KEY,
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

import type * as Profiles from "../goatclaw/PermissionProfiles.ts";
import * as Settings from "../serverSettings.ts";

import * as McpInvocationContext from "./McpInvocationContext.ts";
import { availability, type CallerProfile, callerProfile } from "./toolAvailability.ts";

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The listing a caller gets. Agents GOAT runs (thread callers) get the one the settings ask for.
 * A client keeps the full listing unless it sends the listing header with "core": another GOAT
 * host's dispatch reads a remote's tools/list to learn which launch arguments and memory tools it
 * supports, and hosts on older versions cannot learn that any other way. The header only picks
 * what tools/list shows; calls never read it.
 */
export const callerListing = (
  scope: McpInvocationContext.McpInvocationScope,
  setting: AgentToolListing,
  requested: string | undefined,
): AgentToolListing => {
  if (scope.thread !== undefined) return setting;
  return requested?.trim().toLowerCase() === "core" ? "core" : "full";
};

/** The listing this caller is shown, and the one agents GOAT runs get, which tools/list names. */
interface Listing {
  readonly listed: AgentToolListing;
  readonly agents: AgentToolListing;
}

/**
 * The tools a caller is listed: none it cannot use, and in the core listing only entries the
 * registry lists as core. Core entries carry the always-load marker in both listings, so harnesses
 * that defer tools (Claude Code, Pi) keep them resident. Unlisted tools stay callable by name.
 */
const listedTools = (
  tools: ReadonlyArray<unknown>,
  scope: McpInvocationContext.McpInvocationScope,
  listing: AgentToolListing,
  profile: CallerProfile | undefined,
): ReadonlyArray<unknown> =>
  tools.flatMap((tool) => {
    if (!isRecord(tool) || typeof tool.name !== "string") return [tool];
    const entry = resolveAgentSurfaceEntry(tool.name);
    if (entry === undefined) return [tool];
    if (!availability(entry, scope, true, profile).now) return [];
    const core = "listing" in entry && entry.listing === "core";
    if (listing === "core" && !core) return [];
    if (!core) return [tool];
    const meta = isRecord(tool._meta) ? tool._meta : {};
    return [{ ...tool, _meta: { ...meta, [ALWAYS_LOAD_META_KEY]: true } }];
  });

/**
 * A JSON-RPC message with its tools/list result filtered and naming the listing agents get; any
 * other message unchanged.
 */
const filterMessage = (
  text: string,
  scope: McpInvocationContext.McpInvocationScope,
  listing: Listing,
  profile: CallerProfile | undefined,
) => {
  const message = Option.getOrUndefined(decodeJson(text));
  if (!isRecord(message) || !isRecord(message.result) || !Array.isArray(message.result.tools))
    return text;
  const meta = isRecord(message.result._meta) ? message.result._meta : {};
  return encodeJson({
    ...message,
    result: {
      ...message.result,
      tools: listedTools(message.result.tools, scope, listing.listed, profile),
      _meta: { ...meta, [AGENT_TOOL_LISTING_META_KEY]: listing.agents },
    },
  });
};

/** SSE text with each event's tools/list result filtered. */
const filterEvents = (
  text: string,
  scope: McpInvocationContext.McpInvocationScope,
  listing: Listing,
  profile: CallerProfile | undefined,
) =>
  text
    .split("\n")
    .map((line) =>
      line.startsWith("data:")
        ? `data: ${filterMessage(line.slice(5).trim(), scope, listing, profile)}`
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
  listing: Listing,
  profile?: CallerProfile,
) {
  if (body._tag !== "Uint8Array" && body._tag !== "Stream") return body;
  const text =
    body._tag === "Uint8Array"
      ? new TextDecoder().decode(body.body)
      : yield* body.stream.pipe(Stream.decodeText, Stream.mkString, Effect.orDie);
  const filtered = body.contentType.includes("text/event-stream")
    ? filterEvents(text, scope, listing, profile)
    : filterMessage(text, scope, listing, profile);
  return HttpBody.text(filtered, body.contentType);
});

/**
 * The profile tools/list follows. Clients keep a listing for the session, so a profile that does
 * not resolve lists every tool: its calls report the refusal, and goat_describe reports it live.
 */
const listingProfile = Effect.fnUntraced(function* (
  permissions: Option.Option<Profiles.PermissionProfiles["Service"]>,
  scope: McpInvocationContext.McpInvocationScope,
) {
  if (Option.isNone(permissions)) return undefined;
  const profile = yield* callerProfile(permissions.value, scope);
  if (profile?.resolved !== false) return profile;
  yield* Effect.logWarning("listing tools without the goatclaw profile: it does not resolve", {
    reason: profile.reason,
  });
  return undefined;
});

/**
 * Filters tools/list by caller here, around Effect's MCP core: the core guards tools/list and
 * tools/call with one visibility check, so a tool it hid could not be called by name.
 */
export const withCallerListing = (
  listing: Effect.Effect<AgentToolListing>,
  permissions: Option.Option<Profiles.PermissionProfiles["Service"]>,
) =>
  /* The auth middleware's span already covers each request. */
  Effect.fnUntraced(function* <E, R>(
    httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
  ) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (request.method !== "POST") return yield* httpEffect;
    // The body is read once and cached, so the MCP server reads this same text afterwards.
    const body = yield* Effect.option(request.text);
    // A cheap guard only, so it must pass every spelling of the method: JSON writes "tools" either
    // literally or with \u escapes ("to\u006fls"), and the decoded method then decides.
    if (Option.isNone(body) || !(body.value.includes("tools") || body.value.includes("\\u")))
      return yield* httpEffect;
    const call = Option.getOrUndefined(decodeJson(body.value));
    if (!isRecord(call) || call.method !== "tools/list") return yield* httpEffect;
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const agents = yield* listing;
    const listed = callerListing(scope, agents, request.headers[AGENT_TOOL_LISTING_HEADER]);
    const profile = yield* listingProfile(permissions, scope);
    const response = yield* httpEffect;
    return HttpServerResponse.setBody(
      response,
      yield* filterToolsListBody(response.body, scope, { listed, agents }, profile),
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

/**
 * The settings changes after which clients should list tools again (MCP list_changed): the
 * listing setting, or the goatclaw policy, since a thread's listing leaves out what its profile
 * refuses. A save that changes neither is skipped.
 */
export const listingChanges = (
  settings: Option.Option<Settings.ServerSettingsService["Service"]>,
) => {
  if (Option.isNone(settings)) return Stream.empty;
  const service = settings.value;
  const policyOf = (current: { readonly goatclaw: unknown }) => JSON.stringify(current.goatclaw);
  return Stream.unwrap(
    Effect.gen(function* () {
      // Changes carry no initial snapshot, so compare against what clients were listed from.
      let listed = yield* listingSetting(settings);
      let policy = yield* service.getSettings.pipe(
        Effect.map(policyOf),
        Effect.catch(() => Effect.succeed(undefined)),
      );
      return service.streamChanges.pipe(
        Stream.filter((current) => {
          if (current.agentToolListing === listed && policyOf(current) === policy) return false;
          listed = current.agentToolListing;
          policy = policyOf(current);
          return true;
        }),
      );
    }),
  );
};
