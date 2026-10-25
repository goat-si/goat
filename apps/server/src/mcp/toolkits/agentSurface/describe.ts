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

import type * as Profiles from "../../../goatclaw/PermissionProfiles.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { availability, type CallerProfile, callerProfile } from "../../toolAvailability.ts";
import type { ToolDispatch } from "../../ToolDispatch.ts";
import { hostOfCursor, THIS_BUILD } from "./hostDescribe.ts";
import { type Match, nearestPaths, searchEntries } from "./search.ts";
import type { DescribeResult } from "./tools.ts";

const entries: ReadonlyArray<AgentSurfaceRegistryEntry> = Object.values(agentSurfaceRegistry);
const guideOf = (entry: AgentSurfaceEntry) => entry.guide;

// FNV-1a over every field an agent relies on or search reads, so a cursor from an earlier
// registry is refused; stable across processes, unlike object identity.
export const surfaceVersionOf = (
  entries: ReadonlyArray<
    AgentSurfaceEntry & { readonly path: string; readonly legacyNames: ReadonlyArray<string> }
  >,
) => {
  let hash = 0x811c9dc5;
  for (const entry of entries)
    for (const char of `${JSON.stringify([entry.path, entry.name, entry.legacyNames, entry.effect, entry.requires, entry.summary, entry.description, guideOf(entry) ?? ""])}\n`) {
      hash ^= char.charCodeAt(0);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  return hash.toString(16).padStart(8, "0");
};
const surfaceVersion = surfaceVersionOf(entries);

const DEFAULT_LIMIT = 10;
const SEARCHED_FIELDS = ["path", "name", "summary", "description", "guide"] as const;

/** Who asks: availability follows their scope and, for a thread, their goatclaw profile. */
interface Caller {
  readonly scope: McpInvocationContext.McpInvocationScope;
  readonly profile: CallerProfile | undefined;
}
type Detail = "names" | "summary" | "full";

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

export const makeDescribe = (
  dispatch: ToolDispatch["Service"],
  permissions: Profiles.PermissionProfiles["Service"],
) => {
  const served = (entry: AgentSurfaceRegistryEntry) =>
    dispatch.served(listedToolName(entry)) !== undefined;

  const availableTo = (entry: AgentSurfaceRegistryEntry, caller: Caller, isServed: boolean) =>
    availability(entry, caller.scope, isServed, caller.profile);

  const listed = (entry: AgentSurfaceRegistryEntry, caller: Caller, detail: Detail) =>
    detail === "names"
      ? { path: entry.path, name: listedToolName(entry), summary: entry.summary }
      : {
          path: entry.path,
          name: listedToolName(entry),
          summary: entry.summary,
          effect: entry.effect,
          requires: entry.requires,
          available: availableTo(entry, caller, served(entry)),
          description: entry.description,
        };

  const matched = (
    { entry, match, matchedWords, unmatchedWords }: Match<AgentSurfaceRegistryEntry>,
    caller: Caller,
    detail: Detail,
  ) => ({
    ...listed(entry, caller, detail),
    match,
    ...(match === "exact" ? {} : { matchedWords, unmatchedWords }),
  });

  const search = Effect.fn("AgentSurface.search")(function* (
    caller: Caller,
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
      const cursorHost = hostOfCursor(input.cursor);
      if (cursorHost !== undefined)
        return yield* refuse(
          `This cursor continues a search on ${cursorHost}. Pass host ${cursorHost} with it.`,
        );
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
    // A cursor is only issued with matches left, so one at or past the end is not this search's.
    if (input.cursor !== undefined && offset >= outcome.matches.length)
      return yield* refuse(
        "This cursor points past the matches this search has. Search again without cursor.",
      );
    const page = outcome.matches.slice(offset, offset + input.limit);
    const next = offset + page.length;
    const matchedEntries = outcome.matches.map(({ entry }) => entry);
    const unserved = matchedEntries.filter((entry) => !served(entry));
    return {
      depth: "search" as const,
      surfaceVersion,
      build: THIS_BUILD,
      query: input.query,
      mode: outcome.mode,
      entries: page.map((match) => matched(match, caller, input.detail)),
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
          (entry) => served(entry) && !availableTo(entry, caller, true).now,
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
    // The surface depth names resources only, so it never pays for resolving a profile.
    const caller: Caller = {
      scope,
      profile:
        input.path === undefined && input.query === undefined
          ? undefined
          : yield* callerProfile(permissions, scope),
    };
    if (input.detail === "full" && (input.query !== undefined || input.path === undefined))
      return yield* refuse(
        'detail "full" describes one path: pass its path, such as "thread.send", without query.',
      );
    const limit = input.limit ?? DEFAULT_LIMIT;
    if (input.query !== undefined)
      return yield* search(caller, {
        query: input.query,
        path: input.path,
        detail,
        limit,
        cursor: input.cursor,
      });
    const entry = input.path === undefined ? undefined : resolveAgentSurfaceEntry(input.path);
    const isResource = entries.some((candidate) => candidate.resource === input.path);
    // A name that is no path or resource is searched, never answered with absence; its cursor
    // continues that search.
    if (input.path !== undefined && entry === undefined && !isResource)
      return yield* search(caller, {
        query: input.path,
        path: undefined,
        detail: detail === "full" ? "summary" : detail,
        limit,
        cursor: input.cursor,
      });
    if (input.cursor !== undefined)
      return yield* refuse("cursor continues a search: pass the same query it came with.");
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
    if (entry !== undefined && input.detail !== undefined && input.detail !== "full")
      return {
        depth: "path" as const,
        entry: listed(entry, caller, input.detail),
      } satisfies DescribeResult;
    if (entry !== undefined) {
      const tool = dispatch.served(listedToolName(entry));
      return {
        depth: "path" as const,
        entry: {
          path: entry.path,
          name: listedToolName(entry),
          summary: entry.summary,
          effect: entry.effect,
          available: availableTo(entry, caller, tool !== undefined),
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
    return {
      depth: "resource" as const,
      resource: input.path,
      entries: inResource
        .toSorted((a, b) => a.verb.localeCompare(b.verb))
        .map((candidate) => listed(candidate, caller, detail === "full" ? "summary" : detail)),
    } satisfies DescribeResult;
  });
};
