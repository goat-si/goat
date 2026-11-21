import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS channel_bot_attention (
    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
    owner_id TEXT NOT NULL,
    bot_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL CHECK (kind IN ('question', 'approval', 'sign_in', 'failed', 'finished')),
    request_id TEXT,
    generation INTEGER NOT NULL,
    occurred_at TEXT NOT NULL
  )`;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_bot_attention_owner_sequence
    ON channel_bot_attention (owner_id, sequence)`;
});
