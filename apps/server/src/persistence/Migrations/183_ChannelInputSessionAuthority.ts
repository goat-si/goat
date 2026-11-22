import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(channel_inbox)`;
  if (!columns.some((column) => column.name === "auth_session_id")) {
    yield* sql`ALTER TABLE channel_inbox ADD COLUMN auth_session_id TEXT`;
  }
});
