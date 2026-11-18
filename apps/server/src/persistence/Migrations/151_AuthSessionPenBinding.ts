import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Principal kind and Pen binding, written once at issue (mesh link design §5-§6). */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(auth_sessions)
  `;
  const has = (name: string) => columns.some((column) => column.name === name);
  if (!has("principal_kind")) {
    yield* sql`
      ALTER TABLE auth_sessions
      ADD COLUMN principal_kind TEXT NOT NULL DEFAULT 'person'
    `;
    yield* sql`
      UPDATE auth_sessions SET principal_kind = 'outside_client' WHERE subject = 'mcp-client'
    `;
  }
  for (const column of ["pen_mesh_id", "pen_node_id", "pen_sign_pub", "pen_noise_pub"]) {
    if (!has(column)) yield* sql.unsafe(`ALTER TABLE auth_sessions ADD COLUMN ${column} TEXT`);
  }
  yield* sql`
    CREATE INDEX IF NOT EXISTS auth_sessions_pen_node_idx
    ON auth_sessions(pen_node_id) WHERE pen_node_id IS NOT NULL
  `;
  // Nothing may rewrite who a session speaks for or which Pen member it is bound to.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS auth_sessions_binding_immutable
    BEFORE UPDATE OF principal_kind, pen_mesh_id, pen_node_id, pen_sign_pub, pen_noise_pub
    ON auth_sessions
    BEGIN
      SELECT RAISE(ABORT, 'auth session principal and Pen binding are immutable');
    END
  `;
});
