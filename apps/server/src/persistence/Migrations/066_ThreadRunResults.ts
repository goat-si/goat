import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // What an agent reported about one of its runs with goat_thread_report_result.
  // A later report for the same run replaces the earlier one. Facts GOAT already
  // keeps elsewhere (run status, linked pull requests, branch) are merged on read.
  yield* sql`
    CREATE TABLE IF NOT EXISTS thread_run_results (
      thread_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      report_json TEXT NOT NULL,
      reported_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, run_id)
    ) WITHOUT ROWID
  `;
});
