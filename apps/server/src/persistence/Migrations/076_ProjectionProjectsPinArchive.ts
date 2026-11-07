import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// Null means unpinned and not archived.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_projects)`;
  if (!columns.some((column) => column.name === "pinned_at")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN pinned_at TEXT`;
  }
  if (!columns.some((column) => column.name === "archived_at")) {
    yield* sql`ALTER TABLE projection_projects ADD COLUMN archived_at TEXT`;
  }
});
