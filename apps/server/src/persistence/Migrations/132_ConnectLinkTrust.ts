import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE connect_link_trust (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    generation INTEGER NOT NULL,
    policy_version INTEGER,
    user_id TEXT
  )`;
  yield* sql`INSERT INTO connect_link_trust VALUES (1, 0, NULL, NULL)`;
  yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN connect_policy_version INTEGER`;
  yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN connect_link_generation INTEGER`;
});
