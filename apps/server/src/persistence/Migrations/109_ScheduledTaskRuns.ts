import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (!columns.some((column) => column.name === "last_firing_id")) {
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN last_firing_id TEXT`;
  }
  yield* sql`CREATE TABLE IF NOT EXISTS scheduled_task_runs (
    firing_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    task_created_at TEXT NOT NULL,
    message_id TEXT NOT NULL UNIQUE,
    trigger_kind TEXT NOT NULL CHECK(trigger_kind IN ('scheduled','manual','webhook')),
    admitted_next_run_at TEXT,
    admitted_schedule_digest TEXT NOT NULL,
    admitted_enabled INTEGER NOT NULL CHECK(admitted_enabled IN (0,1)),
    webhook_delivery_id TEXT UNIQUE,
    thread_id TEXT,
    run_id TEXT,
    dispatch_status TEXT NOT NULL CHECK(dispatch_status IN ('dispatching','accepted','failed','unknown')),
    status TEXT NOT NULL,
    requested_at TEXT NOT NULL,
    dispatch_bookkept_at TEXT,
    completed_at TEXT,
    last_sequence INTEGER NOT NULL DEFAULT 0,
    attempt INTEGER NOT NULL DEFAULT 1 CHECK(attempt >= 1),
    snapshot_json TEXT NOT NULL,
    CHECK ((dispatch_status='dispatching' AND status='dispatching')
      OR (dispatch_status='accepted' AND status IN ('queued','running','completed','failed','interrupted','cancelled','rolled_back'))
      OR (dispatch_status='failed' AND status='failed') OR (dispatch_status='unknown' AND status='unknown'))
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS scheduled_task_runs_run ON scheduled_task_runs(run_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS scheduled_task_runs_task
    ON scheduled_task_runs(task_id, task_created_at, requested_at DESC, firing_id DESC)`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS scheduled_task_runs_dispatch
    ON scheduled_task_runs(task_id, task_created_at)
    WHERE dispatch_bookkept_at IS NULL OR dispatch_status='dispatching'`;
  yield* sql`CREATE TRIGGER IF NOT EXISTS scheduled_task_runs_delete
    AFTER DELETE ON scheduled_tasks BEGIN
      DELETE FROM scheduled_task_runs WHERE task_id = OLD.task_id AND task_created_at = OLD.created_at;
    END`;
});
