import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Guarded so a relocated migration id can add these columns again. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(remote_dispatches)
  `;
  const names = new Set(columns.map((column) => column.name));
  if (!names.has("delete_requested_at")) {
    yield* sql`ALTER TABLE remote_dispatches ADD COLUMN delete_requested_at TEXT`;
  }
  if (!names.has("delete_request_key")) {
    yield* sql`ALTER TABLE remote_dispatches ADD COLUMN delete_request_key TEXT`;
  }
});
