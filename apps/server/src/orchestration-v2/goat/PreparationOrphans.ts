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
 * How long a run may stay "preparing" with nobody holding its claim before the check fails it.
 * Only the time from a run's commit to the claim its preparation fiber takes first is uncovered.
 * The longest such gap, a delegation's, is two writes and three reads; with each write waiting
 * out busy_timeout (5 s) and two 8 s event-loop stalls it stays under about 30 s.
 */
const PREPARATION_GRACE = Duration.minutes(3);
export const PASS_INTERVAL = Duration.minutes(1);
/** Oldest first, so later passes reach newer runs as older ones leave "preparing". */
const PASS_LIMIT = 200;

export const NOT_STARTED_MESSAGE =
  "Nothing was preparing this run's workspace, so the agent did not start. Retry to prepare it.";

export interface Suspect {
  readonly runId: RunId;
  readonly threadId: ThreadId;
  /** When any of the run's items last changed; a Retry rewrites them, so it starts a new count. */
  readonly lastItemChange: string | null;
}

export type SuspectRead = Effect.Effect<ReadonlyArray<Suspect>, SqlError.SqlError>;

/** The condition of orchestration_v2_projection_runs_recovery_idx (RecoveryIndexes.ts). */
export const RECOVERY_INDEX_STATUSES = ["queued", "preparing", "starting", "running", "waiting"];

// The literal status list repeats the partial index's condition: with status = 'preparing' alone,
// or with bound values, SQLite does not see that the index applies and scans the table. INDEXED BY
// fails the statement loudly if that index ever changes. The sort runs over preparing rows only.
export const SUSPECTS_QUERY = `
  SELECT runs.run_id, runs.thread_id, (
    SELECT MAX(item.updated_at) FROM orchestration_v2_projection_turn_items AS item
    WHERE item.run_id = runs.run_id
  ) AS last_item_change
  FROM orchestration_v2_projection_runs AS runs
    INDEXED BY orchestration_v2_projection_runs_recovery_idx
  WHERE runs.status IN (${RECOVERY_INDEX_STATUSES.map((status) => `'${status}'`).join(", ")})
    AND runs.status = 'preparing'
  ORDER BY runs.requested_at, runs.run_id
  LIMIT ${PASS_LIMIT}`;

const readSuspects = (sql: SqlClient.SqlClient): SuspectRead =>
  sql
    .unsafe<{
      readonly run_id: string;
      readonly thread_id: string;
      readonly last_item_change: string | null;
    }>(SUSPECTS_QUERY)
    .pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          runId: RunId.make(row.run_id),
          threadId: ThreadId.make(row.thread_id),
          lastItemChange: row.last_item_change,
        })),
      ),
    );

// A run's count belongs to one stretch of "preparing": a Retry changes the key, so it starts over.
const countKey = (suspect: Suspect) => `${suspect.runId} ${suspect.lastItemChange ?? ""}`;

/**
 * Fails runs left "preparing" with no preparation under way, such as a launch cut between its
 * commit and its preparation, so Retry works on them. A run counts from the first pass that read
 * it since its items last changed; a pass that finds its claim held starts its count again.
 */
// Untraced: a span here would parent every pass for the server's life; each pass has its own.
const start = Effect.fnUntraced(function* (suspects: SuspectRead) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const claims = yield* PreparationClaims;
  const failing = yield* Ref.make(false);
  const graceMillis = Duration.toMillis(PREPARATION_GRACE);
  let firstSeen = new Map<string, number>();

  const isPreparing = (suspect: Suspect) =>
    threads
      .getThreadRecords(suspect.threadId, ["runs"], { runIds: [suspect.runId] })
      .pipe(
        Effect.map(({ runs }) =>
          runs.some((run) => run.id === suspect.runId && run.status === "preparing"),
        ),
      );

  const failOrphan = Effect.fn("PreparationOrphans.failOrphan")(function* (suspect: Suspect) {
    if (!(yield* isPreparing(suspect))) return;
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
        // Refused because something else ended the run after the read: nothing left to do.
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterrupts(cause),
          (cause) =>
            isPreparing(suspect).pipe(
              Effect.flatMap((still) => (still ? Effect.failCause(cause) : Effect.void)),
            ),
        ),
      );
  });

  const check = Effect.fn("PreparationOrphans.pass")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const read = yield* suspects;
    firstSeen = new Map(
      read.map((suspect) => [countKey(suspect), firstSeen.get(countKey(suspect)) ?? now]),
    );
    const due = read.filter(
      (suspect) => now - (firstSeen.get(countKey(suspect)) ?? now) >= graceMillis,
    );
    const exits = yield* Effect.forEach(due, (suspect) =>
      Effect.exit(claims.whileClaimed(suspect.runId, failOrphan(suspect))).pipe(
        Effect.tap((exit) =>
          Effect.sync(() => {
            // A claimed run is being prepared, so its count starts again.
            if (Exit.isSuccess(exit) && !exit.value) firstSeen.set(countKey(suspect), now);
          }),
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

/** The check with its read wrapped, so a test can observe and fail it. */
export const layerWithRead = (wrap: (read: SuspectRead) => SuspectRead) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* start(wrap(NodeSqliteClient.backgroundReads(readSuspects(sql))));
    }),
  );

export const layer = layerWithRead((read) => read);
