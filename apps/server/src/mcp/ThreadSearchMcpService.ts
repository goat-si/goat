import {
  OrchestratorMcpFailure,
  OrchestratorMcpThreadSearchResult,
  type OrchestratorMcpThreadSearchInput,
  type OrchestratorMcpThreadSearchMatch,
  type OrchestratorMcpThreadStatus,
  type ProjectId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as SshRemoteDispatch from "../sshRemote/SshRemoteDispatch.ts";
import * as HostThreadsMcpService from "./HostThreadsMcpService.ts";
import { withHostFanOutDeadline } from "./hostFanOutDeadline.ts";
import { McpInvocationContext, type McpInvocationScope } from "./McpInvocationContext.ts";
import { readCaller, unavailable } from "./threadAccess.ts";

/**
 * goat_thread_search: title and message search in this environment, on one
 * SSH host, or fanned out over several. Each environment searches only
 * itself and pages by offset; a fan-out merges every environment's next page
 * newest first and keeps one offset per environment in its cursor, which
 * makes each merged page exact.
 */

const DEFAULT_LIMIT = 50;
/** Most matching threads one environment considers per search, newest first. */
const MATCH_SCAN_LIMIT = 1_000;
const HOST_LIMIT = 16;
/** The cursor key for this environment in a fan-out cursor. */
const HERE = "";
const FAN_OUT_CURSOR_PREFIX = "h1.";

type Match = OrchestratorMcpThreadSearchMatch;
type Page = OrchestratorMcpThreadSearchResult;

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

/** Newest first, as goat_thread_list orders; the host breaks the last tie. */
const newestFirst = (left: Match, right: Match) =>
  Date.parse(right.updatedAt) - Date.parse(left.updatedAt) ||
  right.threadId.localeCompare(left.threadId) ||
  (left.host ?? "").localeCompare(right.host ?? "");

const FanOutCursor = Schema.Struct({
  /** Matches already returned from each environment, keyed by host ("" is here). */
  offsets: Schema.Record(Schema.String, Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  /** Environments with nothing left to return. */
  done: Schema.Array(Schema.String),
});
type FanOutCursor = typeof FanOutCursor.Type;
const decodeFanOutCursor = Schema.decodeUnknownOption(Schema.fromJsonString(FanOutCursor));

const badCursor = () =>
  failure("invalid_request", "cursor is not a nextCursor from this kind of search.");

const offsetFrom = (cursor: string | undefined) => {
  if (cursor === undefined) return Effect.succeed(0);
  return /^\d{1,9}$/.test(cursor) ? Effect.succeed(Number(cursor)) : Effect.fail(badCursor());
};

const fanOutCursorFrom = (cursor: string | undefined) => {
  if (cursor === undefined) return Effect.succeed<FanOutCursor>({ offsets: {}, done: [] });
  if (!cursor.startsWith(FAN_OUT_CURSOR_PREFIX)) return Effect.fail(badCursor());
  const decoded = decodeFanOutCursor(
    Buffer.from(cursor.slice(FAN_OUT_CURSOR_PREFIX.length), "base64url").toString("utf8"),
  );
  return decoded._tag === "Some" ? Effect.succeed(decoded.value) : Effect.fail(badCursor());
};

const encodeFanOutCursor = (cursor: FanOutCursor) =>
  FAN_OUT_CURSOR_PREFIX + Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");

/** A canonical ISO time, so a host and SQLite compare it the same way. */
const isoBound = Effect.fnUntraced(function* (value: string | undefined, name: string) {
  if (value === undefined) return undefined;
  const parsed = DateTime.make(value);
  if (Option.isNone(parsed))
    return yield* failure("invalid_request", `${name} must be an ISO date-time.`);
  return DateTime.formatIso(parsed.value);
});

interface Filters {
  readonly query: string;
  readonly statuses: ReadonlyArray<OrchestratorMcpThreadStatus> | undefined;
  readonly updatedAfter: string | undefined;
  readonly updatedBefore: string | undefined;
  readonly includeArchived: boolean;
}

interface EnvironmentSearch extends Filters {
  /** Undefined searches every project. */
  readonly projectId: ProjectId | undefined;
  readonly offset: number;
  readonly limit: number;
}

/**
 * Merges each environment's next page into one page of `limit` and advances
 * every environment's offset by what it contributed. Each page must be that
 * environment's newest matches from its offset, in `newestFirst` order.
 */
function mergeSearchPages(
  cursor: FanOutCursor,
  pages: ReadonlyArray<{ readonly key: string; readonly page: Page }>,
  limit: number,
): { readonly matches: Array<Match>; readonly cursor: FanOutCursor | null } {
  const tagged = pages.flatMap(({ key, page }) => page.matches.map((match) => ({ key, match })));
  const taken = tagged
    .toSorted((left, right) => newestFirst(left.match, right.match))
    .slice(0, limit);
  const offsets = { ...cursor.offsets };
  const done = new Set(cursor.done);
  for (const { key, page } of pages) {
    const count = taken.filter((entry) => entry.key === key).length;
    offsets[key] = (offsets[key] ?? 0) + count;
    if (page.nextCursor === null && count === page.matches.length) done.add(key);
  }
  const remaining = pages.some(({ key }) => !done.has(key));
  return {
    matches: taken.map((entry) => entry.match),
    cursor: remaining ? { offsets, done: [...done].toSorted() } : null,
  };
}

export class ThreadSearchMcpService extends Context.Service<
  ThreadSearchMcpService,
  {
    readonly search: (
      scope: McpInvocationScope,
      input: OrchestratorMcpThreadSearchInput,
    ) => Effect.Effect<OrchestratorMcpThreadSearchResult, OrchestratorMcpFailure>;
  }
>()("goat/mcp/ThreadSearchMcpService") {}

const decodeResult = Schema.decodeUnknownEffect(OrchestratorMcpThreadSearchResult);

const make = Effect.gen(function* () {
  const threadSearch = yield* ThreadSearch.ThreadSearch;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const hostThreads = yield* HostThreadsMcpService.HostThreadsMcpService;
  const dispatch = yield* SshRemoteDispatch.SshRemoteDispatch;

  const searchHere = Effect.fn("ThreadSearchMcpService.searchHere")(function* (
    input: EnvironmentSearch,
  ) {
    // Status lives on the thread shell, which also has the current title.
    const shells = yield* threads.listProjectThreads({
      projectId: input.projectId,
      includeSubagents: true,
      includeArchived: input.includeArchived,
    });
    const statuses = input.statuses === undefined ? null : new Set(input.statuses);
    const eligible =
      statuses === null
        ? shells
        : shells.filter((shell) => statuses.has(shell.activityRunStatus ?? shell.status));
    const empty = { matches: [], nextCursor: null, truncated: false } satisfies Page;
    if (eligible.length === 0) return empty;
    const shellById = new Map(eligible.map((shell) => [shell.id, shell]));
    // A status filter narrows the scan itself, so the cap counts only eligible threads.
    const rows = yield* threadSearch.matchThreads({
      query: input.query,
      projectId: input.projectId,
      ...(statuses === null ? {} : { threadIds: eligible.map((shell) => shell.id) }),
      includeArchived: input.includeArchived,
      updatedAfter: input.updatedAfter,
      updatedBefore: input.updatedBefore,
      limit: MATCH_SCAN_LIMIT + 1,
    });
    if (rows.length === 0) return empty;
    const after = input.updatedAfter === undefined ? null : Date.parse(input.updatedAfter);
    const before = input.updatedBefore === undefined ? null : Date.parse(input.updatedBefore);
    const matches = rows
      .slice(0, MATCH_SCAN_LIMIT)
      .flatMap((row): Array<Match> => {
        const shell = shellById.get(row.threadId);
        if (shell === undefined) return [];
        const status = shell.activityRunStatus ?? shell.status;
        const updatedMs = DateTime.toEpochMillis(shell.updatedAt);
        if ((after !== null && updatedMs < after) || (before !== null && updatedMs >= before))
          return [];
        return [
          {
            threadId: row.threadId,
            projectId: row.projectId,
            projectTitle: row.projectTitle,
            title: shell.title,
            status,
            updatedAt: DateTime.formatIso(shell.updatedAt),
            archived: shell.archivedAt !== null,
            source: row.source,
            snippet: row.snippet,
            messageCreatedAt: row.messageCreatedAt,
          },
        ];
      })
      .toSorted(newestFirst);
    const page = matches.slice(input.offset, input.offset + input.limit);
    const end = input.offset + page.length;
    return {
      matches: page,
      nextCursor: end < matches.length ? String(end) : null,
      truncated: rows.length > MATCH_SCAN_LIMIT,
    } satisfies Page;
  }, Effect.mapError(unavailable));

  /** The host's own goat_thread_search over its own threads, tagged with the host. */
  const searchOnHost = Effect.fn("ThreadSearchMcpService.searchOnHost")(function* (
    scope: McpInvocationScope,
    host: string,
    input: EnvironmentSearch,
  ) {
    const result = yield* hostThreads
      .readOnHost(
        scope,
        {
          host,
          tool: "goat_thread_search",
          // Strict on the remote, so only set keys are sent. The caller has no
          // thread there, so an omitted project means all of them.
          arguments: {
            query: input.query,
            limit: input.limit,
            ...(input.projectId === undefined
              ? { allProjects: true }
              : { projectId: input.projectId }),
            ...(input.statuses === undefined ? {} : { statuses: input.statuses }),
            ...(input.updatedAfter === undefined ? {} : { updatedAfter: input.updatedAfter }),
            ...(input.updatedBefore === undefined ? {} : { updatedBefore: input.updatedBefore }),
            ...(input.includeArchived ? { includeArchived: true } : {}),
            ...(input.offset === 0 ? {} : { cursor: String(input.offset) }),
          },
        },
        decodeResult,
      )
      .pipe(
        Effect.mapError((error) =>
          error.code === "invalid_request" && error.message.includes("does not take")
            ? failure(
                "invalid_request",
                `GOAT on ${host} is too old to search with host filters; update GOAT there.`,
              )
            : error,
        ),
      );
    return {
      matches: result.matches.map((match) => ({ ...match, host })),
      nextCursor: result.nextCursor,
      truncated: result.truncated,
    } satisfies Page;
  });

  const search = Effect.fn("ThreadSearchMcpService.search")(function* (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadSearchInput,
  ) {
    const fanOut = input.allHosts === true || input.hosts !== undefined;
    if (input.projectId !== undefined && input.allProjects === true)
      return yield* failure("invalid_request", "Pass either projectId or allProjects, not both.");
    if (fanOut && input.host !== undefined)
      return yield* failure(
        "invalid_request",
        "Pass host to search one machine, or hosts/allHosts to search several, not both.",
      );
    if (fanOut && input.projectId !== undefined)
      return yield* failure(
        "invalid_request",
        "hosts and allHosts search every project; project ids belong to one environment, so omit projectId.",
      );
    const filters: Filters = {
      query: input.query,
      statuses: input.statuses,
      updatedAfter: yield* isoBound(input.updatedAfter, "updatedAfter"),
      updatedBefore: yield* isoBound(input.updatedBefore, "updatedBefore"),
      includeArchived: input.includeArchived === true,
    };
    const limit = input.limit ?? DEFAULT_LIMIT;

    if (!fanOut) {
      const offset = yield* offsetFrom(input.cursor);
      if (input.host !== undefined) {
        return yield* searchOnHost(scope, input.host, {
          ...filters,
          projectId: input.projectId,
          offset,
          limit,
        });
      }
      // An omitted project is the caller's own; a client outside a thread searches every project.
      const { caller } = yield* readCaller().pipe(
        Effect.provideService(McpInvocationContext, scope),
        Effect.provideService(ThreadManagementService.ThreadManagementService, threads),
      );
      return yield* searchHere({
        ...filters,
        projectId: input.allProjects === true ? undefined : (input.projectId ?? caller?.projectId),
        offset,
        limit,
      });
    }

    const cursor = yield* fanOutCursorFrom(input.cursor);
    const aliases = [
      ...new Set(
        [...(input.allHosts === true ? yield* dispatch.connectedHosts : []), ...(input.hosts ?? [])]
          .map((host) => host.trim())
          .filter((host) => host !== HERE),
      ),
    ].toSorted();
    const reached = aliases.slice(0, HOST_LIMIT);
    const keys = [...(input.allHosts === true ? [HERE] : []), ...reached].filter(
      (key) => !cursor.done.includes(key),
    );
    const environment = (key: string): EnvironmentSearch => ({
      ...filters,
      projectId: undefined,
      offset: cursor.offsets[key] ?? 0,
      limit,
    });
    const results = yield* Effect.forEach(
      keys,
      (key) =>
        (key === HERE
          ? searchHere(environment(key))
          : searchOnHost(scope, key, environment(key)).pipe(withHostFanOutDeadline(key))
        ).pipe(
          Effect.result,
          Effect.map((result) => ({ key, result })),
        ),
      { concurrency: "unbounded" },
    );
    const pages: Array<{ key: string; page: Page }> = [];
    const failed: Array<string> = [];
    const unavailableHosts = aliases.slice(HOST_LIMIT).map((host) => ({
      host,
      code: "invalid_request",
      message: `Skipped: one search reaches at most ${HOST_LIMIT} hosts. Search it with host.`,
    }));
    for (const { key, result } of results) {
      if (result._tag === "Success") pages.push({ key, page: result.success });
      // This environment failing is the call failing; only other machines are reported.
      else if (key === HERE) return yield* result.failure;
      else {
        failed.push(key);
        unavailableHosts.push({
          host: key,
          code: result.failure.code,
          message: result.failure.message,
        });
      }
    }
    // A host that fails is left out of later pages, which keeps them newest first and lets the
    // search end; search it again on its own once it answers.
    const merged = mergeSearchPages(
      { offsets: cursor.offsets, done: [...cursor.done, ...failed] },
      pages,
      limit,
    );
    return {
      matches: merged.matches,
      nextCursor: merged.cursor === null ? null : encodeFanOutCursor(merged.cursor),
      truncated: pages.some(({ page }) => page.truncated),
      unavailableHosts,
    } satisfies Page;
  });

  return ThreadSearchMcpService.of({ search });
});

export const layer = Layer.effect(ThreadSearchMcpService, make);
