import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * One row per thread whose turn items live in a cold archive file instead of this database.
 * `archived` rows may still have rows to delete until `rows_deleted` is set; `restoring` rows
 * are being copied back; `deleted` rows had their archive removed by the hard-delete policy.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS orchestration_v2_thread_history_archives (
    thread_id TEXT PRIMARY KEY,
    state TEXT NOT NULL CHECK (state IN ('archived', 'restoring', 'deleted')),
    archived_at TEXT NOT NULL,
    file_name TEXT NOT NULL,
    file_bytes INTEGER NOT NULL CHECK (file_bytes >= 0),
    raw_bytes INTEGER NOT NULL CHECK (raw_bytes >= 0),
    item_count INTEGER NOT NULL CHECK (item_count >= 0),
    event_count INTEGER NOT NULL CHECK (event_count >= 0),
    sha256 TEXT NOT NULL,
    frames_json TEXT NOT NULL,
    rows_deleted INTEGER NOT NULL DEFAULT 0 CHECK (rows_deleted IN (0, 1))
  )`;
});
