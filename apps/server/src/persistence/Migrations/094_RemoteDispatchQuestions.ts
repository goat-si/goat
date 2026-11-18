import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The remote task's open questions, a JSON array of request ids, as last observed.
 * Guarded so a relocated id can run again over its own column.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(remote_dispatches)
  `;
  if (!columns.some((column) => column.name === "pending_request_ids")) {
    yield* sql`ALTER TABLE remote_dispatches ADD COLUMN pending_request_ids TEXT`;
  }
});
