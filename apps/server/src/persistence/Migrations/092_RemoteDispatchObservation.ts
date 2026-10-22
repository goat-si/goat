import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The remote task's last worker observation, JSON, so the origin can echo it and a local
 * worker can show a remote subagent's approvals without opening SSH.
 * Guarded so a relocated id can run again over its own column.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(remote_dispatches)
  `;
  if (!columns.some((column) => column.name === "observation")) {
    yield* sql`ALTER TABLE remote_dispatches ADD COLUMN observation TEXT`;
  }
});
