import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE IF NOT EXISTS remote_report_bindings (
      thread_id TEXT PRIMARY KEY NOT NULL,
      correlation_id TEXT UNIQUE NOT NULL,
      origin_label TEXT NOT NULL,
      origin_thread_id TEXT NOT NULL,
      read_key_hash TEXT NOT NULL,
      last_sequence INTEGER NOT NULL DEFAULT 0 CHECK(last_sequence >= 0),
      created_at TEXT NOT NULL
    )
  `;
  yield* sql`
    CREATE TABLE IF NOT EXISTS remote_reports (
      correlation_id TEXT NOT NULL,
      sequence INTEGER NOT NULL CHECK(sequence > 0),
      run_id TEXT,
      kind TEXT NOT NULL CHECK(kind IN ('progress','completed','failed','needs_input')),
      summary TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY(correlation_id, sequence),
      FOREIGN KEY(correlation_id) REFERENCES remote_report_bindings(correlation_id) ON DELETE CASCADE
    )
  `;
});
