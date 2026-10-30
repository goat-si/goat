import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE computer_use_person_approval (id INTEGER PRIMARY KEY CHECK (id = 1))`;
  yield* sql`INSERT INTO computer_use_person_approval (id)
    SELECT 1 FROM orchestration_v2_projection_turn_items
    WHERE type = 'human_handoff'
      AND json_extract(payload_json, '$.handoff.target.path') = 'computer_use.grant'
      AND json_extract(payload_json, '$.handoff.state') = 'completed'
      AND json_extract(payload_json, '$.handoff.actor.type') = 'client'
    LIMIT 1`;
  yield* sql`CREATE TABLE computer_use_named_messages (
    thread_id TEXT NOT NULL, app_key TEXT NOT NULL, message_id TEXT NOT NULL,
    PRIMARY KEY (thread_id, app_key, message_id)
  )`;
});
