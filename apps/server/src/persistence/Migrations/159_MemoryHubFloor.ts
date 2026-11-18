import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE memory_hub_members ADD COLUMN advertised_features_json TEXT`;
  yield* sql`ALTER TABLE memory_hub_members ADD COLUMN advertised_credential_version INTEGER`;
  yield* sql`CREATE TABLE memory_space_counters (
    space TEXT PRIMARY KEY,
    last_forget_sequence INTEGER NOT NULL
  )`;
});
