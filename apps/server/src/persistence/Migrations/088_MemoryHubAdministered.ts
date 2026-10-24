import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE memory_hub_administration_state (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    administered INTEGER NOT NULL CHECK(administered IN (0,1))
  )`;
  yield* sql`INSERT INTO memory_hub_administration_state(singleton,administered)
    SELECT 1,1 WHERE
      EXISTS(SELECT 1 FROM memory_outbox WHERE kind='admin') OR
      EXISTS(SELECT 1 FROM memory_import_keys WHERE key_kind='hub_admin') OR
      EXISTS(SELECT 1 FROM memory_hub_members) OR
      EXISTS(SELECT 1 FROM memory_last_ready_space)`;
});
