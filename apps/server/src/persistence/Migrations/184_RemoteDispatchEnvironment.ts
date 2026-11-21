import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(remote_dispatches)`;
  if (!columns.some(({ name }) => name === "remote_environment_id"))
    yield* sql`ALTER TABLE remote_dispatches ADD COLUMN remote_environment_id TEXT`;
});
