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
import {
  OWNED,
  STRETCH_CHANGED,
  dispatchGuardedFail,
  generationOf,
  refusalReason,
} from "./PreparationStretch.ts";

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
  /** The run's generation (see PreparationStretch): it names this stretch of "preparing". */
  readonly generation: number | null;
}

export type SuspectRead = Effect.Effect<ReadonlyArray<Suspect>, SqlError.SqlError>;

/** The condition of orchestration_v2_projection_runs_recovery_idx (RecoveryIndexes.ts). */
export const RECOVERY_INDEX_STATUSES = ["queued", "preparing", "starting", "running", "waiting"];

// The literal status list repeats the partial index's condition: with status = 'preparing' alone,
// or with bound values, SQLite does not see that the index applies and scans the table. INDEXED BY
// fails the statement loudly if that index ever changes. Status and generation come from one read.
export const SUSPECTS_QUERY = `
  WITH oldest AS MATERIALIZED (
    SELECT run_id, thread_id, requested_at FROM orchestration_v2_projection_runs
      INDEXED BY orchestration_v2_projection_runs_recovery_idx
    WHERE status IN (${RECOVERY_INDEX_STATUSES.map((status) => `'${status}'`).join(", ")})
      AND status = 'preparing'
    ORDER BY requested_at, run_id
    LIMIT ${PASS_LIMIT}
  )
  SELECT oldest.run_id, oldest.thread_id,
    (${generationOf("oldest.thread_id", String(Number.MAX_SAFE_INTEGER), "oldest.run_id")}) AS generation
  FROM oldest
  ORDER BY oldest.requested_at, oldest.run_id `;

const readSuspects = (sql: SqlClient.SqlClient): SuspectRead =>
  sql
    .unsafe<{
      readonly run_id: string;
      readonly thread_id: string;
      readonly generation: number | null;
    }>(SUSPECTS_QUERY)
    .pipe(
      Effect.map((rows) =>
        rows.map((row) => ({
          runId: RunId.make(row.run_id),
          threadId: ThreadId.make(row.thread_id),
          generation: row.generation,
        })),
      ),
    );

// A count belongs to one stretch of "preparing": any run event changes the key.
const countKey = (suspect: Suspect) => `${suspect.runId} ${suspect.generation ?? ""}`;

/**
 * Fails runs left "preparing" that nothing owns (see PreparationClaims), so Retry works on them,
 * once passes spanning PREPARATION_GRACE each found the run preparing and unowned in the same
 * stretch. The fail commits only if its commit still finds that stretch and no owner.
 */
// Untraced: a span here would parent every pass for the server's life; each pass has its own.
const start = Effect.fnUntraced(function* (suspects: SuspectRead, wait: Effect.Effect<void>) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const claims = yield* PreparationClaims;
  const failing = yield* Ref.make(false);
  const graceMillis = Duration.toMillis(PREPARATION_GRACE);
  let firstSeen = new Map<string, number>();

  const failOrphan = Effect.fn("PreparationOrphans.failOrphan")(function* (
    suspect: Suspect,
    generation: number,
  ) {
    // A fresh id each time: a run retried and stuck again must not replay the first fail.
    const nonce = yield* randomUuidV4;
    yield* dispatchGuardedFail(
      threads,
      claims,
      {
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
      },
      { generation, unlessOwned: true },
    ).pipe(
      // Refused, or rejected because the run moved on since the read: nothing left to do.
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) => {
          const reason = refusalReason(cause);
          if (reason === STRETCH_CHANGED || reason === OWNED) return Effect.void;
          return claims
            .generation(suspect.threadId, suspect.runId)
            .pipe(
              Effect.flatMap((now) => (now === generation ? Effect.failCause(cause) : Effect.void)),
            );
        },
      ),
    );
  });

  const check = Effect.fn("PreparationOrphans.pass")(function* () {
    const now = yield* Clock.currentTimeMillis;
    const read = yield* suspects;
    const next = new Map<string, number>();
    for (const suspect of read) {
      // A run a caller is about to prepare, or one being prepared, starts no count.
      if (yield* claims.isOwned(suspect.threadId, suspect.runId)) continue;
      next.set(countKey(suspect), firstSeen.get(countKey(suspect)) ?? now);
    }
    firstSeen = next;
    const due = read.flatMap((suspect) => {
      const seen = next.get(countKey(suspect));
      return seen !== undefined && suspect.generation !== null && now - seen >= graceMillis
        ? [{ suspect, generation: suspect.generation }]
        : [];
    });
    const exits = yield* Effect.forEach(due, ({ suspect, generation }) =>
      Effect.exit(failOrphan(suspect, generation)),
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
  yield* wait.pipe(Effect.andThen(pass), Effect.forever, Effect.forkScoped);
});

const failureReason = <E extends { readonly _tag: string }>(cause: Cause.Cause<E>) =>
  Option.getOrElse(
    Option.map(Cause.findErrorOption(cause), (error) => error._tag),
    () => "defect",
  );

/** The check with its read and its wait between passes wrapped, so a test can step it. */
export const layerWith = (wrap: {
  readonly read: (read: SuspectRead) => SuspectRead;
  readonly wait: (wait: Effect.Effect<void>) => Effect.Effect<void>;
}) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* start(
        wrap.read(NodeSqliteClient.backgroundReads(readSuspects(sql))),
        wrap.wait(Effect.sleep(PASS_INTERVAL)),
      );
    }),
  );

export const layer = layerWith({ read: (read) => read, wait: (wait) => wait });
