import { CommandId, RunId, ThreadId } from "@goat/contracts";
import { makeProviderFailure } from "@goat/provider-core/server/failure";
import * as NodeSqliteClient from "@goat/shared/nodeSqliteClient";
import { randomUuidV4 } from "@goat/shared/randomUuid";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import * as ThreadManagement from "../ThreadManagementService.ts";
import { PreparationClaims } from "./PreparationClaims.ts";
import { PREPARATION_NOT_STARTED_CODE } from "./PreparationFailure.ts";

/**
 * How long a run must stay "preparing" with nothing owning it before the check fails it. Every step
 * from a run's commit to its preparation is owned (see PreparationClaims), so this covers no timing
 * gap; it is how long a person waits before Retry is offered.
 */
const PREPARATION_GRACE = Duration.minutes(3);
export const PASS_INTERVAL = Duration.minutes(1);
/** Oldest first, so later passes reach newer runs as older ones leave "preparing". */
const PASS_LIMIT = 200;

export const NOT_STARTED_MESSAGE =
  "Nothing is preparing this run's workspace, so the agent did not start. Retry to prepare it.";

export interface Suspect {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  /** When any of the run's items last changed; a failure and a Retry rewrite them. */
  readonly lastItemChange: string | null;
}

export type SuspectRead = Effect.Effect<ReadonlyArray<Suspect>, SqlError.SqlError>;

interface RunNow {
  readonly status: string;
  readonly lastItemChange: string | null;
}

export type RunRead = (runId: RunId) => Effect.Effect<Option.Option<RunNow>, SqlError.SqlError>;

/** The condition of orchestration_v2_projection_runs_recovery_idx (RecoveryIndexes.ts). */
export const RECOVERY_INDEX_STATUSES = ["queued", "preparing", "starting", "running", "waiting"];

const lastItemChange = (runColumn: string) => `
    SELECT MAX(item.updated_at) FROM orchestration_v2_projection_turn_items AS item
    WHERE item.run_id = ${runColumn}`;

// The literal status list repeats the partial index's condition: with status = 'preparing' alone,
// or with bound values, SQLite does not see that the index applies and scans the table. INDEXED BY
// fails the statement loudly if that index ever changes. Items are looked up for the kept runs only.
export const SUSPECTS_QUERY = `
  WITH oldest AS MATERIALIZED (
    SELECT run_id, thread_id, requested_at FROM orchestration_v2_projection_runs
      INDEXED BY orchestration_v2_projection_runs_recovery_idx
    WHERE status IN (${RECOVERY_INDEX_STATUSES.map((status) => `'${status}'`).join(", ")})
      AND status = 'preparing'
    ORDER BY requested_at, run_id
    LIMIT ${PASS_LIMIT}
  )
  SELECT oldest.run_id, oldest.thread_id, (${lastItemChange("oldest.run_id")}) AS last_item_change
  FROM oldest
  ORDER BY oldest.requested_at, oldest.run_id `;

const RUN_QUERY = `
  SELECT runs.status, (${lastItemChange("runs.run_id")}) AS last_item_change
  FROM orchestration_v2_projection_runs AS runs
  WHERE runs.run_id = ?`;

type Row = { readonly last_item_change: string | null };

const readSuspects = (sql: SqlClient.SqlClient): SuspectRead =>
  sql.unsafe<Row & { readonly run_id: string; readonly thread_id: string }>(SUSPECTS_QUERY).pipe(
    Effect.map((rows) =>
      rows.map((row) => ({
        runId: RunId.make(row.run_id),
        threadId: ThreadId.make(row.thread_id),
        lastItemChange: row.last_item_change,
      })),
    ),
  );

const readRun =
  (sql: SqlClient.SqlClient): RunRead =>
  (runId) =>
    sql.unsafe<Row & { readonly status: string }>(RUN_QUERY, [runId]).pipe(
      Effect.map((rows) =>
        Option.map(Option.fromNullishOr(rows[0]), (row) => ({
          status: row.status,
          lastItemChange: row.last_item_change,
        })),
      ),
    );

// A count belongs to one stretch of "preparing": a failure or a Retry changes the key.
const countKey = (suspect: Suspect) => `${suspect.runId} ${suspect.lastItemChange ?? ""}`;

/**
 * Fails runs left "preparing" that nothing owns (see PreparationClaims), so Retry works on them: only
 * once passes spanning PREPARATION_GRACE each found the run preparing, unowned and with the same
 * newest item change, and only after re-reading that under the run's claim.
 */
// Untraced: a span here would parent every pass for the server's life; each pass has its own.
const start = Effect.fnUntraced(function* (input: {
  readonly suspects: SuspectRead;
  readonly run: RunRead;
}) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const claims = yield* PreparationClaims;
  const failing = yield* Ref.make(false);
  const graceMillis = Duration.toMillis(PREPARATION_GRACE);
  let firstSeen = new Map<string, number>();

  const owned = (suspect: Suspect) =>
    Effect.zipWith(
      claims.isPending(suspect.threadId),
      claims.isHeld(suspect.runId),
      (pending, held) => pending || held,
    );
  const unchanged = (suspect: Suspect) =>
    input
      .run(suspect.runId)
      .pipe(
        Effect.map(
          Option.exists(
            (now) => now.status === "preparing" && now.lastItemChange === suspect.lastItemChange,
          ),
        ),
      );

  // Runs holding the run's claim, so no preparation of it can start meanwhile.
  const failOrphan = Effect.fn("PreparationOrphans.failOrphan")(function* (suspect: Suspect) {
    if (!(yield* unchanged(suspect))) return;
    // A caller or a preparation that asked for the run meanwhile owns it.
    if ((yield* claims.isPending(suspect.threadId)) || (yield* claims.hasWaiters(suspect.runId)))
      return;
    // A fresh id each time: a run retried and stuck again must not replay the first fail.
    const nonce = yield* randomUuidV4;
    yield* threads
      .dispatch({
        type: "prepared-run.fail",
        commandId: CommandId.make(`${suspect.runId}:preparation-not-started:${nonce}`),
        threadId: suspect.threadId,
        runId: suspect.runId,
        failure: makeProviderFailure({
          class: "unknown",
          code: PREPARATION_NOT_STARTED_CODE,
          message: NOT_STARTED_MESSAGE,
          retryable: true,
        }),
      })
      .pipe(
        // Refused because the run changed after the read: nothing left to do.
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) =>
            unchanged(suspect).pipe(
              Effect.flatMap((still) => (still ? Effect.failCause(cause) : Effect.void)),
            ),
        ),
      );
  });

  const check = Effect.fn("PreparationOrphans.pass")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const read = yield* input.suspects;
    const next = new Map<string, number>();
    for (const suspect of read) {
      // A run a caller is about to prepare, or one being prepared, starts no count.
      if (yield* owned(suspect)) continue;
      next.set(countKey(suspect), firstSeen.get(countKey(suspect)) ?? now);
    }
    firstSeen = next;
    const due = read.filter((suspect) => {
      const seen = next.get(countKey(suspect));
      return seen !== undefined && now - seen >= graceMillis;
    });
    const exits = yield* Effect.forEach(due, (suspect) =>
      Effect.exit(claims.tryClaim(suspect.runId, failOrphan(suspect))).pipe(
        Effect.tap((exit) =>
          Exit.isSuccess(exit) && !exit.value
            ? Effect.sync(() => firstSeen.delete(countKey(suspect)))
            : Effect.void,
        ),
      ),
    );
    // One run's failure stops no other run; it keeps its count and is tried again next pass.
    const failed = exits.find(Exit.isFailure);
    if (failed !== undefined) return yield* failed;
  });

  // Logs the first failure of a run of failing passes and the pass that ends it.
  const pass = check().pipe(
    Effect.andThen(Ref.getAndSet(failing, false)),
    Effect.flatMap((recovered) =>
      recovered
        ? Effect.logInfo("Checking for runs nothing is preparing works again")
        : Effect.void,
    ),
    Effect.catchCauseIf(
      (cause) => !Cause.hasInterrupts(cause),
      (cause) =>
        Ref.getAndSet(failing, true).pipe(
          Effect.flatMap((already) =>
            already
              ? Effect.void
              : Effect.logWarning(
                  "Could not check for runs nothing is preparing; retrying every minute",
                  // A bounded category only: a defect's text could carry anything.
                  { reason: failureReason(cause) },
                ),
          ),
        ),
    ),
  );
  yield* Effect.sleep(PASS_INTERVAL).pipe(Effect.andThen(pass), Effect.forever, Effect.forkScoped);
});

const failureReason = <E extends { readonly _tag: string }>(cause: Cause.Cause<E>) =>
  Option.getOrElse(
    Option.map(Cause.findErrorOption(cause), (error) => error._tag),
    () => "defect",
  );

/** The check with its reads wrapped, so a test can observe, hold and fail them. */
export const layerWith = (wrap: {
  readonly suspects: (read: SuspectRead) => SuspectRead;
  readonly run: (read: RunRead) => RunRead;
}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* start({
        suspects: wrap.suspects(NodeSqliteClient.backgroundReads(readSuspects(sql))),
        run: wrap.run((runId) => NodeSqliteClient.backgroundReads(readRun(sql)(runId))),
      });
    }),
  );

export const layer = layerWith({ suspects: (read) => read, run: (read) => read });
