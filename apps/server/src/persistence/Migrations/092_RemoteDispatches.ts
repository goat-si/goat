import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS remote_dispatches (
    correlation_id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('thread','task')),
    origin_thread_id TEXT NOT NULL, host TEXT NOT NULL, remote_thread_id TEXT,
    launched_run_id TEXT, read_key TEXT NOT NULL,
    delivery TEXT NOT NULL CHECK(delivery IN ('notify_only','next_turn','wake')),
    reports_supported INTEGER NOT NULL DEFAULT 0,
    state TEXT NOT NULL CHECK(state IN ('launching','running','idle','settled','cancelled','lost')),
    report_cursor INTEGER NOT NULL DEFAULT 0, known_run_id TEXT, known_run_status TEXT,
    latest_kind TEXT, latest_summary TEXT, latest_at TEXT,
    cancel_requested_at TEXT, cancel_ceiling TEXT, task_id TEXT, parent_run_id TEXT,
    last_error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS remote_dispatches_origin_idx
    ON remote_dispatches(origin_thread_id, created_at)`;
  yield* sql`CREATE INDEX IF NOT EXISTS remote_dispatches_state_idx ON remote_dispatches(state)`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS remote_dispatches_task_idx
    ON remote_dispatches(origin_thread_id, task_id) WHERE task_id IS NOT NULL`;
  yield* sql`CREATE TABLE IF NOT EXISTS remote_report_inbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT, origin_thread_id TEXT NOT NULL,
    correlation_id TEXT NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL, created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS remote_report_inbox_origin_idx
    ON remote_report_inbox(origin_thread_id, id)`;
});
