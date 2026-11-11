import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { RETAIN_MS } from "./PlacementReservations.ts";

/**
 * The placer's history of placed attempts (design §11, "Unknown outcomes and new attempts"): one
 * row per key, never reused. An unknown attempt stays pinned to its target until the target answers
 * from its record or a person chooses to run again.
 */

export class PlacementAttemptsError extends Schema.TaggedError<PlacementAttemptsError>()(
  "PlacementAttemptsError",
  { operation: Schema.String, cause: Schema.optional(Schema.Defect()) },
) {}

export type AttemptState = "unknown" | "started" | "not_started";

export interface Attempt {
  readonly ownerKey: string;
  readonly attempt: number;
  readonly issuedAt: number;
  readonly targetHost: string;
  /** The launch exactly as first sent; every retry of this key sends it again. */
  readonly payloadJson: string;
  readonly state: AttemptState;
  readonly threadId: string | null;
  readonly runId: string | null;
  readonly rerunBy: string | null;
  readonly rerunAt: number | null;
  readonly cleanupThreadId: string | null;
  readonly lastAnswer: string | null;
  readonly createdAt: number;
}

export type Resolved =
  /** A new key: send it. */
  | { readonly _tag: "Created"; readonly attempt: Attempt }
  /** The current key, unknown: send the same key and payload again. */
  | { readonly _tag: "Resend"; readonly attempt: Attempt }
  /** Already started: settle the claim, start nothing. */
  | { readonly _tag: "Started"; readonly attempt: Attempt }
  /** Unknown on another target: nothing may go anywhere else. */
  | { readonly _tag: "PinnedElsewhere"; readonly attempt: Attempt }
  /** The latest allocated attempt's row is gone: its outcome is unknown, nothing new starts. */
  | { readonly _tag: "Pruned" };

/**
 * The owner's latest allocated attempt, read against the never-pruned counter: a missing row for
 * that number is a gap, whatever older rows remain.
 */
export type Lookup =
  | { readonly _tag: "None" }
  | { readonly _tag: "Found"; readonly attempt: Attempt }
  | { readonly _tag: "Gap"; readonly attempt: number; readonly rerunBy: string | null };

export interface PlacementAttemptsShape {
  readonly resolve: (input: {
    readonly ownerKey: string;
    readonly targetHost: string;
    readonly payloadJson: string;
    readonly now: number;
  }) => Effect.Effect<Resolved, PlacementAttemptsError>;
  readonly lookup: (ownerKey: string) => Effect.Effect<Lookup, PlacementAttemptsError>;
  /** Whether any attempt was ever allocated for this owner; the counter outlives pruned history. */
  readonly everAllocated: (ownerKey: string) => Effect.Effect<boolean, PlacementAttemptsError>;
  /** A failed archive takes the next turn number and goes behind the rest, its host with it. */
  readonly markCleanupTried: (input: {
    readonly ownerKey: string;
    readonly attempt: number;
  }) => Effect.Effect<void, PlacementAttemptsError>;
  /** Also records a late success of an attempt a person already chose to run again. */
  readonly recordStarted: (input: {
    readonly ownerKey: string;
    readonly attempt: number;
    readonly threadId: string;
    readonly runId: string | null;
  }) => Effect.Effect<boolean, PlacementAttemptsError>;
  /** Only from the target's fenced row; the idle thread it left is kept for cleanup. */
  readonly recordNotStarted: (input: {
    readonly ownerKey: string;
    readonly attempt: number;
    readonly threadId: string | null;
  }) => Effect.Effect<boolean, PlacementAttemptsError>;
  readonly recordAnswer: (input: {
    readonly ownerKey: string;
    readonly attempt: number;
    readonly answer: string;
  }) => Effect.Effect<void, PlacementAttemptsError>;
  readonly clearCleanup: (input: {
    readonly ownerKey: string;
    readonly attempt: number;
  }) => Effect.Effect<void, PlacementAttemptsError>;
  /**
   * Takes one host's next batch of idle threads, least recently tried first, and moves the host
   * behind every other host with cleanups, whatever the archives then do.
   */
  readonly nextCleanups: (
    host: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<Attempt>, PlacementAttemptsError>;
  /** Hosts with idle threads left, least recently visited first. */
  readonly hostsWithCleanups: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<string>, PlacementAttemptsError>;
  /** What the "Launch outcome unknown" Inbox item lists. */
  readonly listUnknown: Effect.Effect<ReadonlyArray<Attempt>, PlacementAttemptsError>;
  /** Owners whose latest attempt's row is gone and no person has decided; also for that Inbox item. */
  readonly listPruned: Effect.Effect<
    ReadonlyArray<{ readonly ownerKey: string; readonly attempt: number }>,
    PlacementAttemptsError
  >;
  /**
   * "Run again, it may duplicate": records the person and time on the unknown attempt, or on the
   * owner's counter when that attempt is the missing latest one; false when neither applies.
   */
  readonly chooseRunAgain: (input: {
    readonly ownerKey: string;
    readonly attempt: number;
    readonly decidedBy: string;
    readonly now: number;
  }) => Effect.Effect<boolean, PlacementAttemptsError>;
  readonly prune: (now: number) => Effect.Effect<number, PlacementAttemptsError>;
}

export class PlacementAttempts extends Context.Service<PlacementAttempts, PlacementAttemptsShape>()(
  "goat/fleet/admission/PlacementAttempts",
) {}

interface Row {
  readonly owner_key: string;
  readonly attempt: number;
  readonly issued_at: number;
  readonly target_host: string;
  readonly payload_json: string;
  readonly state: AttemptState;
  readonly thread_id: string | null;
  readonly run_id: string | null;
  readonly rerun_by: string | null;
  readonly rerun_at: number | null;
  readonly cleanup_thread_id: string | null;
  readonly cleanup_turn: number | null;
  readonly last_answer: string | null;
  readonly created_at: number;
}

const fromRow = (row: Row): Attempt => ({
  ownerKey: row.owner_key,
  attempt: row.attempt,
  issuedAt: row.issued_at,
  targetHost: row.target_host,
  payloadJson: row.payload_json,
  state: row.state,
  threadId: row.thread_id,
  runId: row.run_id,
  rerunBy: row.rerun_by,
  rerunAt: row.rerun_at,
  cleanupThreadId: row.cleanup_thread_id,
  lastAnswer: row.last_answer,
  createdAt: row.created_at,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const failed =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(Effect.mapError((cause) => new PlacementAttemptsError({ operation, cause })));

  const counterOf = (ownerKey: string) =>
    sql<{ readonly next_attempt: number }>`
      SELECT next_attempt FROM placement_attempt_counters WHERE owner_key = ${ownerKey}
    `.pipe(Effect.map((rows) => rows[0]?.next_attempt ?? null));

  const lookupIn = Effect.fn("PlacementAttempts.lookupIn")(function* (ownerKey: string) {
    const [counter] = yield* sql<{
      readonly next_attempt: number;
      readonly gap_attempt: number | null;
      readonly gap_rerun_by: string | null;
    }>`
      SELECT next_attempt, gap_attempt, gap_rerun_by FROM placement_attempt_counters
      WHERE owner_key = ${ownerKey}
    `;
    // The counter is written in the same transaction as every attempt row.
    if (counter === undefined) return { _tag: "None" } satisfies Lookup;
    const allocated = counter.next_attempt - 1;
    const [row] = yield* sql<Row>`
      SELECT * FROM placement_attempts WHERE owner_key = ${ownerKey} AND attempt = ${allocated}
    `;
    if (row !== undefined) return { _tag: "Found", attempt: fromRow(row) } satisfies Lookup;
    return {
      _tag: "Gap",
      attempt: allocated,
      rerunBy: counter.gap_attempt === allocated ? counter.gap_rerun_by : null,
    } satisfies Lookup;
  });

  const resolve = Effect.fn("PlacementAttempts.resolve")(function* (
    input: Parameters<PlacementAttemptsShape["resolve"]>[0],
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const found = yield* lookupIn(input.ownerKey);
          if (found._tag === "Gap" && found.rerunBy === null) return { _tag: "Pruned" } as const;
          const latest = found._tag === "Found" ? found.attempt : null;
          if (latest?.state === "started") return { _tag: "Started", attempt: latest } as const;
          if (latest?.state === "unknown" && latest.rerunBy === null)
            return latest.targetHost === input.targetHost
              ? ({ _tag: "Resend", attempt: latest } as const)
              : ({ _tag: "PinnedElsewhere", attempt: latest } as const);
          // A new key only after a fenced "not started" or a person's choice on the latest attempt;
          // the counter is never pruned, so no key repeats whatever the clock does.
          const [counter] = yield* sql<{ readonly next_attempt: number }>`
            INSERT INTO placement_attempt_counters (owner_key, next_attempt) VALUES (${input.ownerKey}, 1)
            ON CONFLICT (owner_key) DO UPDATE SET next_attempt = next_attempt + 1
            RETURNING next_attempt
          `;
          const attempt = (counter?.next_attempt ?? 1) - 1;
          const [inserted] = yield* sql<Row>`
            INSERT INTO placement_attempts
              (owner_key, attempt, issued_at, target_host, payload_json, state, created_at)
            VALUES (${input.ownerKey}, ${attempt}, ${input.now}, ${input.targetHost},
              ${input.payloadJson}, 'unknown', ${input.now})
            RETURNING *
          `;
          if (inserted === undefined)
            return yield* new PlacementAttemptsError({
              operation: "resolve",
              cause: "Insert returned no row.",
            });
          return { _tag: "Created", attempt: fromRow(inserted) } as const;
        }),
      )
      .pipe(failed("resolve"));
  });

  const changed = (rows: ReadonlyArray<unknown>) => rows.length > 0;

  return PlacementAttempts.of({
    resolve,
    lookup: Effect.fn("PlacementAttempts.lookup")(function* (ownerKey: string) {
      return yield* sql.withTransaction(lookupIn(ownerKey)).pipe(failed("lookup"));
    }),
    everAllocated: Effect.fn("PlacementAttempts.everAllocated")(function* (ownerKey: string) {
      return (yield* counterOf(ownerKey).pipe(failed("everAllocated"))) !== null;
    }),
    markCleanupTried: Effect.fn("PlacementAttempts.markCleanupTried")(function* (input) {
      // A turn number, never the clock: a clock change cannot reorder who goes next.
      yield* sql`
        UPDATE placement_attempts
        SET cleanup_turn = (SELECT COALESCE(MAX(cleanup_turn), 0) + 1 FROM placement_attempts)
        WHERE owner_key = ${input.ownerKey} AND attempt = ${input.attempt}
      `.pipe(failed("markCleanupTried"));
    }),
    recordStarted: Effect.fn("PlacementAttempts.recordStarted")(function* (input) {
      const rows = yield* sql`
        UPDATE placement_attempts SET state = 'started', thread_id = ${input.threadId}, run_id = ${input.runId}
        WHERE owner_key = ${input.ownerKey} AND attempt = ${input.attempt} AND state = 'unknown'
        RETURNING attempt
      `.pipe(failed("recordStarted"));
      return changed(rows);
    }),
    recordNotStarted: Effect.fn("PlacementAttempts.recordNotStarted")(function* (input) {
      const rows = yield* sql`
        UPDATE placement_attempts
        SET state = 'not_started', thread_id = ${input.threadId}, cleanup_thread_id = ${input.threadId}
        WHERE owner_key = ${input.ownerKey} AND attempt = ${input.attempt} AND state = 'unknown'
        RETURNING attempt
      `.pipe(failed("recordNotStarted"));
      return changed(rows);
    }),
    recordAnswer: Effect.fn("PlacementAttempts.recordAnswer")(function* (input) {
      yield* sql`
        UPDATE placement_attempts SET last_answer = ${input.answer.slice(0, 500)}
        WHERE owner_key = ${input.ownerKey} AND attempt = ${input.attempt}
      `.pipe(failed("recordAnswer"));
    }),
    clearCleanup: Effect.fn("PlacementAttempts.clearCleanup")(function* (input) {
      yield* sql`
        UPDATE placement_attempts SET cleanup_thread_id = NULL
        WHERE owner_key = ${input.ownerKey} AND attempt = ${input.attempt}
      `.pipe(failed("clearCleanup"));
    }),
    nextCleanups: Effect.fn("PlacementAttempts.nextCleanups")(function* (
      host: string,
      limit: number,
    ) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const rows = yield* sql<Row>`
              SELECT * FROM placement_attempts
              WHERE cleanup_thread_id IS NOT NULL AND target_host = ${host}
              ORDER BY COALESCE(cleanup_turn, 0), created_at, owner_key LIMIT ${limit}
            `;
            if (rows.length > 0)
              yield* sql`
                INSERT INTO placement_cleanup_hosts (host, turn)
                VALUES (${host}, (SELECT COALESCE(MAX(turn), 0) + 1 FROM placement_cleanup_hosts))
                ON CONFLICT (host) DO UPDATE SET turn = excluded.turn
              `;
            return rows.map(fromRow);
          }),
        )
        .pipe(failed("nextCleanups"));
    }),
    hostsWithCleanups: Effect.fn("PlacementAttempts.hostsWithCleanups")(function* (limit: number) {
      const rows = yield* sql<{ readonly target_host: string }>`
        SELECT a.target_host FROM placement_attempts a
        LEFT JOIN placement_cleanup_hosts h ON h.host = a.target_host
        WHERE a.cleanup_thread_id IS NOT NULL
        GROUP BY a.target_host ORDER BY COALESCE(MAX(h.turn), 0), a.target_host LIMIT ${limit}
      `.pipe(failed("hostsWithCleanups"));
      return rows.map((row) => row.target_host);
    }),
    listUnknown: sql<Row>`
      SELECT * FROM placement_attempts WHERE state = 'unknown' AND rerun_by IS NULL ORDER BY created_at
    `.pipe(
      Effect.map((rows) => rows.map(fromRow)),
      failed("listUnknown"),
    ),
    listPruned: sql<{ readonly owner_key: string; readonly attempt: number }>`
      SELECT c.owner_key, c.next_attempt - 1 AS attempt FROM placement_attempt_counters c
      WHERE NOT EXISTS (
          SELECT 1 FROM placement_attempts a
          WHERE a.owner_key = c.owner_key AND a.attempt = c.next_attempt - 1
        )
        AND (c.gap_attempt IS NULL OR c.gap_attempt <> c.next_attempt - 1)
      ORDER BY c.owner_key
    `.pipe(
      Effect.map((rows) => rows.map((row) => ({ ownerKey: row.owner_key, attempt: row.attempt }))),
      failed("listPruned"),
    ),
    chooseRunAgain: Effect.fn("PlacementAttempts.chooseRunAgain")(function* (input) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const onRow = yield* sql`
              UPDATE placement_attempts SET rerun_by = ${input.decidedBy}, rerun_at = ${input.now}
              WHERE owner_key = ${input.ownerKey} AND attempt = ${input.attempt}
                AND state = 'unknown' AND rerun_by IS NULL
              RETURNING attempt
            `;
            if (changed(onRow)) return true;
            const onGap = yield* sql`
              UPDATE placement_attempt_counters
              SET gap_attempt = ${input.attempt}, gap_rerun_by = ${input.decidedBy},
                gap_rerun_at = ${input.now}
              WHERE owner_key = ${input.ownerKey} AND next_attempt - 1 = ${input.attempt}
                AND (gap_attempt IS NULL OR gap_attempt <> ${input.attempt})
                AND NOT EXISTS (
                  SELECT 1 FROM placement_attempts
                  WHERE owner_key = ${input.ownerKey} AND attempt = ${input.attempt}
                )
              RETURNING owner_key
            `;
            return changed(onGap);
          }),
        )
        .pipe(failed("chooseRunAgain"));
    }),
    prune: Effect.fn("PlacementAttempts.prune")(function* (now: number) {
      const cutoff = now - RETAIN_MS;
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            // The latest attempt keeps its row, so its outcome still answers; only its payload goes.
            const deleted = yield* sql`
              DELETE FROM placement_attempts
              WHERE state IN ('started', 'not_started') AND cleanup_thread_id IS NULL
                AND issued_at < ${cutoff}
                AND attempt < (
                  SELECT c.next_attempt - 1 FROM placement_attempt_counters c
                  WHERE c.owner_key = placement_attempts.owner_key
                )
              RETURNING attempt
            `;
            yield* sql`
              UPDATE placement_attempts SET payload_json = ''
              WHERE state IN ('started', 'not_started') AND cleanup_thread_id IS NULL
                AND issued_at < ${cutoff} AND payload_json <> ''
            `;
            yield* sql`
              DELETE FROM placement_cleanup_hosts WHERE host NOT IN (
                SELECT target_host FROM placement_attempts WHERE cleanup_thread_id IS NOT NULL
              )
            `;
            return deleted.length;
          }),
        )
        .pipe(failed("prune"));
    }),
  });
});

export const layer = Layer.effect(PlacementAttempts, make);
