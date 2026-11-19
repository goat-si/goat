import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE memory_identity_ledger ADD COLUMN scope_version INTEGER NOT NULL DEFAULT 0 CHECK(scope_version>=0)`;
  yield* sql`ALTER TABLE memory_revisions ADD COLUMN scope_move_held INTEGER NOT NULL DEFAULT 0 CHECK(scope_move_held IN (0,1))`;
});
