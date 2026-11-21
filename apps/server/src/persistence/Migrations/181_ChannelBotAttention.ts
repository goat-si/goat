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
  yield* sql`CREATE INDEX IF NOT EXISTS channel_bot_attention_expiry
    ON channel_bot_attention (occurred_at, sequence)`;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_bot_attention_approval_openings
    ON orchestration_events (stream_id, json_extract(payload_json, '$.runId'))
    WHERE application_event_version = 2 AND aggregate_kind = 'thread'
      AND event_type = 'turn-item.updated'
      AND json_extract(payload_json, '$.type') = 'human_handoff'
      AND json_extract(payload_json, '$.handoff.kind') = 'approval'
      AND json_extract(payload_json, '$.handoff.state') = 'pending'`;
});
