import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Finds a task's interim messages that already reached a person, without reading history, and
 * records when a delivery was handed to its transport, so a restart before that sends it again.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE channel_outbox ADD COLUMN send_started_at TEXT`;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_outbox_interim_told_idx
    ON channel_outbox(task_id, destination_kind)
    WHERE kind = 'receipt' AND state IN ('delivered', 'ambiguous')`;
});
