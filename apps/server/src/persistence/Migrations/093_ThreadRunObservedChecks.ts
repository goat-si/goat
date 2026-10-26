import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The project's check script as GOAT ran it after a run completed, kept beside
  // the agent's own report in thread_run_results. One row per run.
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_run_observed_checks (
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      status TEXT NOT NULL,
      skip_reason TEXT,
      command TEXT NOT NULL,
      exit_code INTEGER,
      duration_ms INTEGER,
      started_at TEXT NOT NULL,
      output_tail TEXT,
      PRIMARY KEY (thread_id, run_id)
    ) WITHOUT ROWID
  `;
});
