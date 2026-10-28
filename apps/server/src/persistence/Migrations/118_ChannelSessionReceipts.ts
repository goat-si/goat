import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE channel_session_receipts (
    input_id TEXT PRIMARY KEY REFERENCES channel_inbox(input_id),
    task_id TEXT NOT NULL REFERENCES channel_tasks(task_id),
    source TEXT NOT NULL CHECK (source IN ('session', 'fallback', 'fixed')),
    run_id TEXT,
    turn_item_id TEXT,
    text TEXT NOT NULL,
    committed_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE session_held_provider_events (
    run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    task_generation INTEGER NOT NULL,
    sequence INTEGER NOT NULL,
    event_json TEXT NOT NULL,
    PRIMARY KEY (run_id, sequence)
  )`;
});
