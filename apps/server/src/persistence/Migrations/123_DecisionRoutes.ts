import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Where a child's decision was routed: the parent recorded when it was asked, its wake delivery,
 * and the parent's hand-off to the person. Projected questions get a row only when escalated.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE decision_routes (
    decision_id TEXT PRIMARY KEY,
    parent_thread_id TEXT NOT NULL,
    notify_attempts INTEGER NOT NULL DEFAULT 0,
    last_attempted_at TEXT,
    message_id TEXT,
    notified_at TEXT,
    failed_at TEXT,
    escalated_by TEXT,
    escalated_at TEXT,
    escalation_reason TEXT
  )`;
  yield* sql`CREATE INDEX decision_routes_due_idx ON decision_routes(last_attempted_at, decision_id)
    WHERE notified_at IS NULL AND failed_at IS NULL`;
});
