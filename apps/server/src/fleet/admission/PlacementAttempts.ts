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
  | { readonly _tag: "PinnedElsewhere"; readonly attempt: Attempt };

export interface PlacementAttemptsShape {
  readonly resolve: (input: {
    readonly ownerKey: string;
    readonly targetHost: string;
    readonly payloadJson: string;
    readonly now: number;
  }) => Effect.Effect<Resolved, PlacementAttemptsError>;
  readonly latest: (ownerKey: string) => Effect.Effect<Attempt | null, PlacementAttemptsError>;
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
  /** Idle threads left on one host, oldest first, at most `limit`. */
  readonly pendingCleanups: (
    host: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<Attempt>, PlacementAttemptsError>;
  readonly hostsWithCleanups: (
    limit: number,
  ) => Effect.Effect<ReadonlyArray<string>, PlacementAttemptsError>;
  /** What the "Launch outcome unknown" Inbox item lists. */
  readonly listUnknown: Effect.Effect<ReadonlyArray<Attempt>, PlacementAttemptsError>;
  /** "Run again, it may duplicate": records the person and time; false when no longer unknown. */
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

  const latestRow = (ownerKey: string) =>
    sql<Row>`
      SELECT * FROM placement_attempts WHERE owner_key = ${ownerKey}
      ORDER BY attempt DESC LIMIT 1
    `.pipe(Effect.map((rows) => (rows[0] === undefined ? null : fromRow(rows[0]))));

  const resolve = Effect.fn("PlacementAttempts.resolve")(function* (
    input: Parameters<PlacementAttemptsShape["resolve"]>[0],
  ) {
    return yield* sql
      .withTransaction(
        Effect.gen(function* () {
          const latest = yield* latestRow(input.ownerKey);
          if (latest !== null && latest.state === "started")
            return { _tag: "Started", attempt: latest } as const;
          if (latest !== null && latest.state === "unknown" && latest.rerunBy === null)
            return latest.targetHost === input.targetHost
              ? ({ _tag: "Resend", attempt: latest } as const)
              : ({ _tag: "PinnedElsewhere", attempt: latest } as const);
          // A new key only after a fenced "not started" or a person's choice; the counter is never
          // pruned, so no key repeats whatever history was deleted or the clock does.
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
    latest: Effect.fn("PlacementAttempts.latest")(function* (ownerKey: string) {
      return yield* latestRow(ownerKey).pipe(failed("latest"));
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
    pendingCleanups: Effect.fn("PlacementAttempts.pendingCleanups")(function* (
      host: string,
      limit: number,
    ) {
      const rows = yield* sql<Row>`
        SELECT * FROM placement_attempts
        WHERE cleanup_thread_id IS NOT NULL AND target_host = ${host}
        ORDER BY created_at LIMIT ${limit}
      `.pipe(failed("pendingCleanups"));
      return rows.map(fromRow);
    }),
    hostsWithCleanups: Effect.fn("PlacementAttempts.hostsWithCleanups")(function* (limit: number) {
      const rows = yield* sql<{ readonly target_host: string }>`
        SELECT DISTINCT target_host FROM placement_attempts
        WHERE cleanup_thread_id IS NOT NULL LIMIT ${limit}
      `.pipe(failed("hostsWithCleanups"));
      return rows.map((row) => row.target_host);
    }),
    listUnknown: sql<Row>`
      SELECT * FROM placement_attempts WHERE state = 'unknown' AND rerun_by IS NULL ORDER BY created_at
    `.pipe(
      Effect.map((rows) => rows.map(fromRow)),
      failed("listUnknown"),
    ),
    chooseRunAgain: Effect.fn("PlacementAttempts.chooseRunAgain")(function* (input) {
      const rows = yield* sql`
        UPDATE placement_attempts SET rerun_by = ${input.decidedBy}, rerun_at = ${input.now}
        WHERE owner_key = ${input.ownerKey} AND attempt = ${input.attempt}
          AND state = 'unknown' AND rerun_by IS NULL
        RETURNING attempt
      `.pipe(failed("chooseRunAgain"));
      return changed(rows);
    }),
    prune: Effect.fn("PlacementAttempts.prune")(function* (now: number) {
      const rows = yield* sql`
        DELETE FROM placement_attempts
        WHERE state IN ('started', 'not_started') AND cleanup_thread_id IS NULL
          AND issued_at < ${now - RETAIN_MS}
        RETURNING attempt
      `.pipe(failed("prune"));
      return rows.length;
    }),
  });
});

export const layer = Layer.effect(PlacementAttempts, make);
