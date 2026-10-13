import {
  IsoDateTime,
  OrchestrationThreadSearchSource,
  type OrchestrationSearchThreadsInput,
  type OrchestrationSearchThreadsResult,
  ProjectId,
  ThreadId,
} from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqlSchema from "effect/sql/SqlSchema";

/** Carries no query text: search input is user content. */
export class ThreadSearchError extends Schema.TaggedError<ThreadSearchError>()(
  "ThreadSearchError",
  {
    operation: Schema.Literals(["query", "decode"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Thread search ${this.operation} failed.`;
  }
}

const SearchRequest = Schema.Struct({ pattern: Schema.String, limit: Schema.Int });
const SearchRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  source: OrchestrationThreadSearchSource,
  matchText: Schema.String,
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});

const MatchRequest = Schema.Struct({
  pattern: Schema.String,
  query: Schema.String,
  projectId: Schema.NullOr(ProjectId),
  threadIdsJson: Schema.NullOr(Schema.String),
  includeArchived: Schema.Boolean,
  updatedAfter: Schema.NullOr(Schema.String),
  updatedBefore: Schema.NullOr(Schema.String),
  limit: Schema.Int,
});
const MatchRow = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  projectTitle: Schema.String,
  title: Schema.String,
  source: Schema.NullOr(OrchestrationThreadSearchSource),
  matchText: Schema.NullOr(Schema.String),
  windowStart: Schema.NullOr(Schema.Int),
  textLength: Schema.NullOr(Schema.Int),
  messageCreatedAt: Schema.NullOr(IsoDateTime),
});

const encodeThreadIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(ThreadId)));

/** Characters of a matched message the query returns, around the first match. */
const MATCH_WINDOW = 480;
const MATCH_WINDOW_LEAD = 160;

function escapeLikePattern(value: string): string {
  return value.replaceAll("!", "!!").replaceAll("%", "!%").replaceAll("_", "!_");
}

function foldAsciiCase(value: string): string {
  return value.replace(/[A-Z]/g, (character) => character.toLowerCase());
}

/**
 * At most 240 characters, centred near the first match. `cut` says whether
 * `text` is itself a window of a longer text, so the snippet shows it.
 */
function buildSearchSnippet(
  text: string,
  query: string,
  cut: { readonly before: boolean; readonly after: boolean } = { before: false, after: false },
): string {
  const normalizedText = text.replace(/\s+/g, " ").trim();
  if (normalizedText.length <= 240 - Number(cut.before) - Number(cut.after)) {
    return `${cut.before ? "…" : ""}${normalizedText}${cut.after ? "…" : ""}`;
  }
  const normalizedQuery = foldAsciiCase(query.replace(/\s+/g, " ").trim());
  const matchIndex = foldAsciiCase(normalizedText).indexOf(normalizedQuery);
  const bodyLength = 236;
  const idealStart = Math.max(0, matchIndex - 72);
  const start = Math.min(idealStart, normalizedText.length - bodyLength);
  const end = Math.min(normalizedText.length, start + bodyLength);
  return `${start > 0 || cut.before ? "…" : ""}${normalizedText.slice(start, end)}${
    end < normalizedText.length || cut.after ? "…" : ""
  }`;
}

export interface ThreadMatchQuery {
  readonly query: string;
  /** Undefined searches every project. */
  readonly projectId: ProjectId | undefined;
  /** Only these threads, when set. */
  readonly threadIds?: ReadonlyArray<ThreadId>;
  readonly includeArchived: boolean;
  /** Canonical ISO times (`Date#toISOString`), compared with stored update times. */
  readonly updatedAfter: string | undefined;
  readonly updatedBefore: string | undefined;
  /** Most threads returned; the newest win. */
  readonly limit: number;
}

export interface ThreadMatch {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly projectTitle: string;
  readonly title: string;
  /** A finished message that matched, else the title. */
  readonly source: OrchestrationThreadSearchSource | "title";
  readonly snippet: string;
  readonly messageCreatedAt: string | null;
}

/**
 * Searches the finished user and assistant messages of active V2 threads in
 * active projects. Legacy V1 transcripts that have not been imported yet are
 * not searched.
 */
export class ThreadSearch extends Context.Service<
  ThreadSearch,
  {
    readonly search: (
      input: OrchestrationSearchThreadsInput,
    ) => Effect.Effect<OrchestrationSearchThreadsResult, ThreadSearchError>;
    /**
     * Threads whose title or a finished user or assistant message contains the
     * query, newest first, one best match each, as `search` ranks them.
     * Archived threads are included only when asked.
     */
    readonly matchThreads: (
      input: ThreadMatchQuery,
    ) => Effect.Effect<ReadonlyArray<ThreadMatch>, ThreadSearchError>;
  }
>()("goat/orchestration-v2/ThreadSearch") {}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One best match per thread: user messages outrank assistant ones, then the
  // newest message wins. Threads order by match kind, then recency.
  const searchRows = SqlSchema.findAll({
    Request: SearchRequest,
    Result: SearchRow,
    execute: ({ pattern, limit }) => sql`
      WITH candidate AS (
        SELECT
          threads.thread_id,
          threads.project_id,
          messages.role,
          json_extract(messages.payload_json, '$.text') AS match_text,
          messages.created_at AS message_created_at,
          messages.message_id,
          threads.updated_at AS thread_updated_at
        FROM orchestration_v2_projection_messages AS messages
        INNER JOIN orchestration_v2_projection_threads AS threads
          ON threads.thread_id = messages.thread_id
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.deleted_at IS NULL
          AND threads.archived_at IS NULL
          AND projects.deleted_at IS NULL
          AND messages.streaming = 0
          AND messages.role IN ('user', 'assistant')
          AND json_extract(messages.payload_json, '$.text') LIKE ${pattern} ESCAPE '!'
      ),
      ranked AS (
        SELECT
          thread_id,
          project_id,
          role AS source,
          match_text,
          message_created_at,
          CASE role WHEN 'user' THEN 0 ELSE 1 END AS match_rank,
          thread_updated_at,
          ROW_NUMBER() OVER (
            PARTITION BY thread_id
            ORDER BY
              CASE role WHEN 'user' THEN 0 ELSE 1 END ASC,
              message_created_at DESC,
              message_id ASC
          ) AS thread_match_rank
        FROM candidate
      )
      SELECT
        thread_id AS "threadId",
        project_id AS "projectId",
        source,
        match_text AS "matchText",
        message_created_at AS "messageCreatedAt"
      FROM ranked
      WHERE thread_match_rank = 1
      ORDER BY match_rank ASC, thread_updated_at DESC, thread_id ASC
      LIMIT ${limit}
    `,
  });

  // The same match ranking as searchRows, over title or content. Only a window
  // of each matched message leaves SQLite, so a page of long transcripts stays
  // small. LIKE and lower() both fold ASCII case only, so instr finds the match.
  const matchRows = SqlSchema.findAll({
    Request: MatchRequest,
    Result: MatchRow,
    execute: (input) => sql`
      WITH candidate_threads AS (
        SELECT
          threads.thread_id,
          threads.project_id,
          threads.title,
          threads.updated_at,
          projects.title AS project_title
        FROM orchestration_v2_projection_threads AS threads
        INNER JOIN projection_projects AS projects
          ON projects.project_id = threads.project_id
        WHERE threads.deleted_at IS NULL
          AND projects.deleted_at IS NULL
          ${input.includeArchived ? sql`` : sql`AND threads.archived_at IS NULL`}
          ${input.projectId === null ? sql`` : sql`AND threads.project_id = ${input.projectId}`}
          ${input.threadIdsJson === null ? sql`` : sql`AND threads.thread_id IN (SELECT value FROM json_each(${input.threadIdsJson}))`}
          ${input.updatedAfter === null ? sql`` : sql`AND threads.updated_at >= ${input.updatedAfter}`}
          ${input.updatedBefore === null ? sql`` : sql`AND threads.updated_at < ${input.updatedBefore}`}
      ),
      message_matches AS (
        SELECT
          messages.thread_id,
          messages.role,
          json_extract(messages.payload_json, '$.text') AS match_text,
          messages.created_at AS message_created_at,
          ROW_NUMBER() OVER (
            PARTITION BY messages.thread_id
            ORDER BY
              CASE messages.role WHEN 'user' THEN 0 ELSE 1 END ASC,
              messages.created_at DESC,
              messages.message_id ASC
          ) AS thread_match_rank
        FROM orchestration_v2_projection_messages AS messages
        INNER JOIN candidate_threads ON candidate_threads.thread_id = messages.thread_id
        WHERE messages.streaming = 0
          AND messages.role IN ('user', 'assistant')
          AND json_extract(messages.payload_json, '$.text') LIKE ${input.pattern} ESCAPE '!'
      ),
      best AS (
        SELECT
          thread_id,
          role,
          match_text,
          message_created_at,
          MAX(1, INSTR(LOWER(match_text), LOWER(${input.query})) - ${MATCH_WINDOW_LEAD}) AS window_start
        FROM message_matches
        WHERE thread_match_rank = 1
      )
      SELECT
        candidate_threads.thread_id AS "threadId",
        candidate_threads.project_id AS "projectId",
        candidate_threads.project_title AS "projectTitle",
        candidate_threads.title AS "title",
        best.role AS "source",
        SUBSTR(best.match_text, best.window_start, ${MATCH_WINDOW}) AS "matchText",
        best.window_start AS "windowStart",
        LENGTH(best.match_text) AS "textLength",
        best.message_created_at AS "messageCreatedAt"
      FROM candidate_threads
      LEFT JOIN best ON best.thread_id = candidate_threads.thread_id
      WHERE best.thread_id IS NOT NULL
        OR candidate_threads.title LIKE ${input.pattern} ESCAPE '!'
      ORDER BY candidate_threads.updated_at DESC, candidate_threads.thread_id DESC
      LIMIT ${input.limit}
    `,
  });

  const mapError = (cause: unknown) =>
    new ThreadSearchError({
      operation: Schema.isSchemaError(cause) ? "decode" : "query",
      cause,
    });

  const matchThreads: ThreadSearch["Service"]["matchThreads"] = Effect.fn(
    "ThreadSearch.matchThreads",
  )(function* (input) {
    const rows = yield* matchRows({
      pattern: `%${escapeLikePattern(input.query)}%`,
      query: input.query,
      projectId: input.projectId ?? null,
      threadIdsJson: input.threadIds === undefined ? null : encodeThreadIds(input.threadIds),
      includeArchived: input.includeArchived,
      updatedAfter: input.updatedAfter ?? null,
      updatedBefore: input.updatedBefore ?? null,
      limit: input.limit,
    }).pipe(Effect.mapError(mapError));
    return rows.map((row): ThreadMatch => {
      const base = {
        threadId: row.threadId,
        projectId: row.projectId,
        projectTitle: row.projectTitle,
        title: row.title,
      };
      if (row.source === null || row.matchText === null) {
        return {
          ...base,
          source: "title",
          snippet: buildSearchSnippet(row.title, input.query),
          messageCreatedAt: null,
        };
      }
      const windowStart = row.windowStart ?? 1;
      return {
        ...base,
        source: row.source,
        snippet: buildSearchSnippet(row.matchText, input.query, {
          before: windowStart > 1,
          // SQLite counts code points, not UTF-16 units.
          after: windowStart - 1 + Array.from(row.matchText).length < (row.textLength ?? 0),
        }),
        messageCreatedAt: row.messageCreatedAt,
      };
    });
  });

  const search: ThreadSearch["Service"]["search"] = Effect.fn("ThreadSearch.search")(
    function* (input) {
      const rows = yield* searchRows({
        pattern: `%${escapeLikePattern(input.query)}%`,
        limit: input.limit ?? 50,
      }).pipe(Effect.mapError(mapError));
      return {
        matches: rows.map((row) => ({
          threadId: row.threadId,
          projectId: row.projectId,
          source: row.source,
          snippet: buildSearchSnippet(row.matchText, input.query),
          messageCreatedAt: row.messageCreatedAt,
        })),
      };
    },
  );

  return ThreadSearch.of({ search, matchThreads });
});

export const layer = Layer.effect(ThreadSearch, make);
