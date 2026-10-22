import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE decision_items (
    id TEXT PRIMARY KEY, from_thread_id TEXT, from_host TEXT,
    title TEXT NOT NULL, context TEXT NOT NULL, options_json TEXT NOT NULL,
    recommended TEXT, required_profile TEXT NOT NULL, expires_at TEXT,
    status TEXT NOT NULL CHECK (status IN ('open', 'answered', 'expired', 'withdrawn')),
    answer TEXT, answered_by TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX decision_items_status_expiry_idx ON decision_items(status, expires_at)`;
  yield* sql`CREATE TABLE audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT, time TEXT NOT NULL, actor TEXT NOT NULL,
    profile TEXT NOT NULL, action TEXT NOT NULL, target TEXT NOT NULL,
    outcome TEXT NOT NULL, decision_id TEXT
  )`;
  yield* sql`CREATE INDEX audit_events_decision_idx ON audit_events(decision_id, id)`;
  yield* sql`CREATE TRIGGER audit_events_no_update BEFORE UPDATE ON audit_events
    BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END`;
  yield* sql`CREATE TRIGGER audit_events_no_delete BEFORE DELETE ON audit_events
    BEGIN SELECT RAISE(ABORT, 'audit_events is append-only'); END`;
  // Projected answers commit in orchestration; their receipt reconciles audit after a crash.
  yield* sql`CREATE TABLE decision_pending_answer_audits (
    command_id TEXT PRIMARY KEY, decision_id TEXT NOT NULL, actor TEXT NOT NULL,
    profile TEXT NOT NULL, reconciled INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE INDEX decision_pending_answer_audits_due_idx
    ON decision_pending_answer_audits(command_id) WHERE reconciled = 0`;
  // Answers commit before delivery. Stable command/message ids make retry after a crash safe.
  yield* sql`CREATE TABLE decision_answer_deliveries (
    decision_id TEXT PRIMARY KEY REFERENCES decision_items(id), delivered_at TEXT,
    last_attempted_at TEXT
  )`;
  yield* sql`CREATE INDEX decision_answer_deliveries_due_idx
    ON decision_answer_deliveries(last_attempted_at, decision_id) WHERE delivered_at IS NULL`;
});
