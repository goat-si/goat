import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE hub_connect_access (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    generation INTEGER NOT NULL,
    allowed INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO hub_connect_access (id, generation, allowed) VALUES (1, 0, 0)`;
  yield* sql`ALTER TABLE auth_pairing_links ADD COLUMN connect_access_generation INTEGER`;
  yield* sql`ALTER TABLE auth_sessions ADD COLUMN connect_access_generation INTEGER`;
});
