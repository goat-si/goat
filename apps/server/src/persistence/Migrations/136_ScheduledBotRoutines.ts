import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// owner_json: who set up a routine bound to a GOAT Bot thread (principal and scopes), which the
// firing speaks for. The link table has no foreign key on purpose: an admitted firing's input is
// still a routine input after the routine or its firing row is deleted.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN owner_json TEXT`;
  yield* sql`CREATE TABLE IF NOT EXISTS scheduled_task_channel_inputs (
    firing_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    input_id TEXT NOT NULL UNIQUE,
    payload_json TEXT NOT NULL,
    state TEXT NOT NULL CHECK(state IN ('pending','ingested','settled')),
    error TEXT,
    created_at TEXT NOT NULL,
    settled_at TEXT
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS scheduled_task_channel_inputs_open
    ON scheduled_task_channel_inputs(state) WHERE state <> 'settled'`;
});
