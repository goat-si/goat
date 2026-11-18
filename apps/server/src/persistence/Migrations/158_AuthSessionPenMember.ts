import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE auth_sessions ADD COLUMN pen_member_node TEXT`;
  yield* sql`ALTER TABLE auth_sessions ADD COLUMN pen_member_revoked_at TEXT`;
  yield* sql`
    CREATE TRIGGER auth_sessions_pen_member_immutable
    BEFORE UPDATE OF pen_member_node ON auth_sessions
    WHEN OLD.pen_member_node IS NOT NEW.pen_member_node
    BEGIN
      SELECT RAISE(ABORT, 'auth session Pen member is immutable');
    END
  `;
});
