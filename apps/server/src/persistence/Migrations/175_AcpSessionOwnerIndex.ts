import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS acp_session_owner_idx
    ON orchestration_v2_projection_provider_threads
      (provider_instance_id, driver, json_extract(payload_json, '$.nativeThreadRef.nativeId'))`;
});
