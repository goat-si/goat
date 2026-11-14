import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { OWES_ACK } from "./attachRow.ts";
import { PenInvites } from "./PenInvites.ts";

const RETENTION_DAYS = 30;
const PRUNE_LIMIT = 100;

/** The retention prune each detach pass ends with. */
export const makePrune = Effect.fn("DetachPrune.make")(function* (
  exclusive: <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E, R>,
) {
  const sql = yield* SqlClient.SqlClient;
  const pen = yield* PenInvites;
  const audit = (attachId: string, action: string, outcome: string) =>
    Effect.flatMap(
      DateTime.now.pipe(Effect.map(DateTime.formatIso)),
      (
        now,
      ) => sql`INSERT INTO audit_events (time, actor, profile, action, target, outcome, decision_id)
        VALUES (${now}, 'goat:disposable', 'hub', ${action}, ${attachId}, ${outcome}, NULL)`,
    );

  /**
   * Design section 3, Retention: a final record whose key is out of Pen, that names no link or link
   * operation and owes Pen no acknowledgement, goes with its request keys 30 days after it ended.
   */
  return Effect.gen(function* () {
    const cutoff = DateTime.formatIso(
      DateTime.subtract(yield* DateTime.now, { days: RETENTION_DAYS }),
    );
    // The 30 days run from the later of ending and leaving Pen. The DELETE asks it all again, as
    // the record may change while Pen's list is read.
    const prunable = sql`final_at IS NOT NULL
    AND max(final_at, coalesce(pen_removed_at, final_at)) < ${cutoff}
    AND (pen_admitted_at IS NULL OR pen_removed_at IS NOT NULL)
    AND link_id IS NULL AND link_operation_id IS NULL AND NOT ${sql.unsafe(OWES_ACK)}`;
    const ended = yield* sql<{
      readonly attach_id: string;
      readonly step: string | null;
      readonly expected_sign_pub: string;
    }>`SELECT attach_id, step, expected_sign_pub FROM disposable_machines
    WHERE ${prunable} ORDER BY final_at LIMIT ${PRUNE_LIMIT}`;
    if (ended.length === 0) return;
    // A released record never had an admit: it goes only once Pen's view shows its key absent.
    const view = yield* Effect.cached(pen.members);
    const gone: Array<string> = [];
    for (const row of ended) {
      if (row.step === "released") {
        const members = yield* view;
        if (members === undefined || members.has(row.expected_sign_pub)) continue;
      }
      gone.push(row.attach_id);
    }
    yield* exclusive(
      sql.withTransaction(
        Effect.forEach(
          gone,
          (attachId) =>
            Effect.gen(function* () {
              const deleted =
                yield* sql`DELETE FROM disposable_machines WHERE attach_id = ${attachId}
              AND ${prunable} RETURNING attach_id`;
              if (deleted.length === 0) return;
              yield* sql`DELETE FROM disposable_machine_requests WHERE attach_id = ${attachId}`;
              yield* audit(attachId, "hub.machine_prune", "deleted");
            }),
          { discard: true },
        ),
      ),
    );
  }).pipe(Effect.withSpan("DisposableDetach.prune"));
});
