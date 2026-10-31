import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE computer_use_input_history (
    id INTEGER PRIMARY KEY,
    thread_id TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    target_kind TEXT NOT NULL CHECK (target_kind IN ('app', 'tab')),
    app_id TEXT,
    app_name TEXT,
    tab_host TEXT,
    method TEXT NOT NULL,
    target_label TEXT,
    verdict TEXT NOT NULL CHECK (verdict IN ('sent', 'refused', 'unknown_outcome')),
    refusal_code TEXT,
    typed_length INTEGER,
    typed_text TEXT,
    reservation_id TEXT UNIQUE,
    control_id TEXT,
    outcome_reported INTEGER NOT NULL DEFAULT 0
  )`;
  yield* sql`CREATE INDEX computer_use_input_history_thread_time
    ON computer_use_input_history(thread_id, recorded_at)`;
});
