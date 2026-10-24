import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * One row per keyed goat_origin_report, written with the report row or the launcher's inbox
 * entry it records, so a retry finds it after the origin collects the report or the launcher's
 * turn consumes it. A launcher wake records its stable command id before it is sent and
 * delivered_at once the dispatch commits.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS remote_report_receipts (
    thread_id TEXT NOT NULL,
    client_request_id TEXT NOT NULL,
    args_digest TEXT NOT NULL,
    kind TEXT NOT NULL,
    sequence INTEGER NOT NULL,
    delivery TEXT NOT NULL CHECK (delivery IN ('origin', 'launcher')),
    wake_thread_id TEXT,
    wake_command_id TEXT,
    delivered_at TEXT,
    created_at TEXT NOT NULL,
    PRIMARY KEY (thread_id, client_request_id)
  )`;
});
