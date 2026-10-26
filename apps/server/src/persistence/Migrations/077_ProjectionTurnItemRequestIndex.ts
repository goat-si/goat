import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX IF NOT EXISTS orchestration_v2_projection_turn_items_thread_request_idx
    ON orchestration_v2_projection_turn_items(thread_id, json_extract(payload_json, '$.requestId'))
    WHERE type IN ('user_input_request', 'approval_request')
  `;
});
