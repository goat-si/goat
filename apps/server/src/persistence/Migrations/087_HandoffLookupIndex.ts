import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Expiry runs every scheduler tick; never scan the rest of the transcript.
  yield* sql`CREATE INDEX orchestration_v2_projection_turn_items_handoff_idx
    ON orchestration_v2_projection_turn_items(status, thread_id, updated_at, turn_item_id)
    WHERE type IN ('human_handoff', 'secret_request')`;
});
