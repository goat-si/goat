import { OrchestratorMcpFailure } from "@goat/contracts";
import {
  type AgentSurfaceEntry,
  agentSurfaceRegistry,
  type AgentSurfaceRegistryEntry,
} from "@goat/contracts/agentSurface";
import {
  canonicalToolName,
  listedToolName,
  resolveAgentSurfaceEntry,
} from "@goat/contracts/agentSurface/resolve";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import type { ToolDispatch } from "../../ToolDispatch.ts";
import { type Match, nearestPaths, searchEntries } from "./search.ts";
import type { DescribeResult } from "./tools.ts";

const entries: ReadonlyArray<AgentSurfaceRegistryEntry> = Object.values(agentSurfaceRegistry);
const guideOf = (entry: AgentSurfaceEntry) => entry.guide;

// FNV-1a over what an agent relies on; stable across processes, unlike object identity.
const surfaceVersion = (() => {
  let hash = 0x811c9dc5;
  for (const entry of entries)
    for (const char of `${entry.path}|${entry.name}|${entry.effect}|${entry.requires}|${entry.description}|${guideOf(entry) ?? ""}\n`) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  return hash.toString(16).padStart(8, "0");
})();

const DEFAULT_LIMIT = 10;
const SEARCHED_FIELDS = ["path", "name", "summary", "description", "guide"] as const;

type Availability = { readonly now: boolean; readonly reason?: string };
type Scope = McpInvocationContext.McpInvocationScope;
type Detail = "names" | "summary" | "full";

/** Only the static refusals this server is sure of; handlers still check at call time. */
const availability = (
  entry: AgentSurfaceRegistryEntry,
  scope: Scope,
  served: boolean,
): Availability => {
  if (!served) return { now: false, reason: "This GOAT server does not serve it." };
  if (entry.resource === "surface") return { now: true };
  if (entry.requires === "thread" && scope.thread === undefined)
    return { now: false, reason: "Needs an agent running inside a GOAT thread." };
  if (entry.requires === "client" && scope.thread !== undefined)
    return { now: false, reason: "Only an outside MCP client can call it." };
  if (entry.effect !== "read" && scope.client?.access === "read-only")
    return { now: false, reason: "This MCP client was approved for read-only access." };
  return { now: true };
};

const Cursor = Schema.fromJsonString(
  Schema.Struct({
    version: Schema.String,
    query: Schema.String,
    path: Schema.NullOr(Schema.String),
    offset: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
);
const encodeCursorJson = Schema.encodeSync(Cursor);
const encodeCursor = (cursor: typeof Cursor.Type) =>
  Buffer.from(encodeCursorJson(cursor)).toString("base64url");
const decodeCursor = Schema.decodeUnknownOption(Cursor);

const refuse = (message: string) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message });

export const makeDescribe = (dispatch: ToolDispatch["Service"]) => {
  const served = (entry: AgentSurfaceRegistryEntry) =>
    dispatch.served(listedToolName(entry)) !== undefined;

  const listed = (entry: AgentSurfaceRegistryEntry, scope: Scope, detail: Detail) =>
    detail === "names"
      ? { path: entry.path, name: listedToolName(entry), summary: entry.summary }
      : {
          path: entry.path,
          name: listedToolName(entry),
          summary: entry.summary,
          effect: entry.effect,
          requires: entry.requires,
          available: availability(entry, scope, served(entry)),
          description: entry.description,
        };

  const matched = (
    { entry, match, matchedWords, unmatchedWords }: Match<AgentSurfaceRegistryEntry>,
    scope: Scope,
    detail: Detail,
  ) => ({
    ...listed(entry, scope, detail),
    match,
    ...(match === "exact" ? {} : { matchedWords, unmatchedWords }),
  });

  const search = Effect.fn("AgentSurface.search")(function* (
    scope: Scope,
    input: {
      readonly query: string;
      readonly path: string | undefined;
      readonly detail: Detail;
      readonly limit: number;
      readonly cursor: string | undefined;
    },
  ) {
    const within =
      input.path === undefined
        ? entries
        : entries.filter((candidate) => candidate.resource === input.path);
    if (within.length === 0)
      return yield* refuse(
        `With query, path narrows the search to one resource, and ${input.path} is not a resource name. Call goat_describe without arguments for the resource names.`,
      );
    let offset = 0;
    if (input.cursor !== undefined) {
      const cursor = decodeCursor(Buffer.from(input.cursor, "base64url").toString("utf8"));
      if (
        cursor._tag === "None" ||
        cursor.value.version !== surfaceVersion ||
        cursor.value.query !== input.query ||
        cursor.value.path !== (input.path ?? null)
      )
        return yield* refuse(
          "This cursor belongs to another search or to an earlier registry. Search again without cursor.",
        );
      offset = cursor.value.offset;
    }
    const outcome = searchEntries(within, input.query);
    const page = outcome.matches.slice(offset, offset + input.limit);
    const next = offset + page.length;
    const matchedEntries = outcome.matches.map(({ entry }) => entry);
    const unserved = matchedEntries.filter((entry) => !served(entry));
    return {
      depth: "search" as const,
      surfaceVersion,
      query: input.query,
      mode: outcome.mode,
      entries: page.map((match) => matched(match, scope, input.detail)),
      total: outcome.matches.length,
      returned: page.length,
      truncated: next < outcome.matches.length,
      ...(next < outcome.matches.length
        ? {
            nextCursor: encodeCursor({
              version: surfaceVersion,
              query: input.query,
              path: input.path ?? null,
              offset: next,
            }),
          }
        : {}),
      coverage: {
        fields: [...SEARCHED_FIELDS],
        resources: input.path === undefined ? "all" : input.path,
        searched: within.length,
        ignoredWords: [...outcome.ignoredWords],
        notServed: unserved.length,
        unavailableToCaller: matchedEntries.filter(
          (entry) => served(entry) && !availability(entry, scope, true).now,
        ).length,
      },
      ...(outcome.matches.length === 0
        ? {
            nearest: [...nearestPaths(within, input.query)],
            next: "No path shares a word with this query, which does not mean GOAT lacks the capability. Try other words, a path from nearest, or goat_describe without arguments for every resource.",
          }
        : {}),
    } satisfies DescribeResult;
  });

  return Effect.fn("AgentSurface.describe")(function* (input: {
    readonly path?: string | undefined;
    readonly query?: string | undefined;
    readonly detail?: Detail | undefined;
    readonly limit?: number | undefined;
    readonly cursor?: string | undefined;
  }) {
    const scope = yield* McpInvocationContext.McpInvocationContext;
    const detail = input.detail ?? "summary";
    if (detail === "full" && (input.query !== undefined || input.path === undefined))
      return yield* refuse(
        'detail "full" describes one path: pass its path, such as "thread.send", without query.',
      );
    const limit = input.limit ?? DEFAULT_LIMIT;
    if (input.query !== undefined)
      return yield* search(scope, {
        query: input.query,
        path: input.path,
        detail,
        limit,
        cursor: input.cursor,
      });
    if (input.cursor !== undefined)
      return yield* refuse("cursor continues a search: pass its query.");
    if (input.path === undefined) {
      const resources = new Map<string, Array<string>>();
      for (const entry of entries)
        resources.set(entry.resource, [...(resources.get(entry.resource) ?? []), entry.verb]);
      return {
        depth: "surface" as const,
        surfaceVersion,
        resources: [...resources.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([resource, verbs]) => ({ resource, verbs: verbs.sort() })),
        next: 'Pass query to search, a resource ("thread") for its paths, or a path ("thread.send") for its schema and availability. Call any path with goat_call.',
      } satisfies DescribeResult;
    }
    const entry = resolveAgentSurfaceEntry(input.path);
    if (entry !== undefined) {
      const tool = dispatch.served(listedToolName(entry));
      return {
        depth: "path" as const,
        entry: {
          path: entry.path,
          name: listedToolName(entry),
          summary: entry.summary,
          effect: entry.effect,
          available: availability(entry, scope, tool !== undefined),
          canonicalName: canonicalToolName(entry),
          legacyNames: entry.legacyNames,
          description: entry.description,
          ...(guideOf(entry) === undefined ? {} : { guide: guideOf(entry) }),
          hostRoutable: entry.hostRoutable,
          requires: entry.requires,
          dryRun: entry.dryRun,
          humanSteps: entry.humanSteps,
          inputSchema: tool?.inputSchema ?? null,
          outputSchema: tool?.outputSchema ?? null,
        },
      } satisfies DescribeResult;
    }
    const inResource = entries.filter((candidate) => candidate.resource === input.path);
    // A name that is neither a path nor a resource is searched, never answered with absence.
    if (inResource.length === 0)
      return yield* search(scope, {
        query: input.path,
        path: undefined,
        detail: detail === "full" ? "summary" : detail,
        limit,
        cursor: undefined,
      });
    return {
      depth: "resource" as const,
      resource: input.path,
      entries: inResource
        .toSorted((a, b) => a.verb.localeCompare(b.verb))
        .map((candidate) => listed(candidate, scope, detail === "full" ? "summary" : detail)),
    } satisfies DescribeResult;
  });
};
