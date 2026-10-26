import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Summary work rows by source thread and the run they observed. Retention asks whether a newer
 * row of the same thread exists; with both keys in the index that is one seek and no JSON
 * parsing, and without it every check scanned the outbox.
 * Idempotent, so tests that run the current store on an older schema can apply it early.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS memory_outbox_summary_thread_idx ON memory_outbox(
    json_extract(metadata_json,'$.sourceThread.threadId'),
    coalesce(json_extract(metadata_json,'$.observedThroughSequence'),json_extract(metadata_json,'$.sourceWatermark.throughSequence'))
  ) WHERE kind IN ('summary','consolidate')`;
});
