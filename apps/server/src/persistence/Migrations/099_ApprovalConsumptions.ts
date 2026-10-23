import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One row per approval that started its change; the key makes a second use fail at insert.
  yield* sql`CREATE TABLE approval_consumptions (
    approval_id TEXT PRIMARY KEY, action TEXT NOT NULL, consumed_at TEXT NOT NULL
  )`;
  // What a server-created inbox decision approves, as an HMAC the server alone can make.
  yield* sql`CREATE TABLE approval_bindings (
    approval_id TEXT PRIMARY KEY, binding TEXT NOT NULL, created_at TEXT NOT NULL
  )`;
});
