import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Receipts contain only opaque identifiers and a query digest. The transcript owns query text.
  yield* sql`CREATE TABLE turn_memory_receipts (
    id INTEGER PRIMARY KEY, thread_id TEXT NOT NULL, run_id TEXT NOT NULL, space TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('automatic','recall')),
    query_digest TEXT, refs_json TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX turn_memory_by_run ON turn_memory_receipts(thread_id, run_id, space, id)`;
  yield* sql`CREATE TABLE turn_memory_receipt_failures (
    thread_id TEXT NOT NULL, run_id TEXT NOT NULL, space TEXT NOT NULL,
    PRIMARY KEY(thread_id, run_id, space)
  )`;
  // Projections can be rebuilt. Only an authoritative thread deletion removes receipts.
  yield* sql`CREATE TRIGGER turn_memory_delete_thread AFTER INSERT ON orchestration_v2_events
    WHEN NEW.event_type='thread.deleted' BEGIN
      DELETE FROM turn_memory_receipts WHERE thread_id=NEW.thread_id;
      DELETE FROM turn_memory_receipt_failures WHERE thread_id=NEW.thread_id;
    END`;
});
