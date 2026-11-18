import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // A fence is the destination's durable proof that a correlation id never bound: a late bind
  // is refused against it, so an origin may release reserved capacity only on its confirmation.
  yield* sql`CREATE TABLE IF NOT EXISTS remote_report_fences (
    correlation_id TEXT PRIMARY KEY,
    read_key_hash TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`;
});
