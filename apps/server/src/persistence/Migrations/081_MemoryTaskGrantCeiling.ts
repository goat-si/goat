import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Missing capture on an existing task or dispatch never inherits a managed provider's default grants.
  yield* sql`
    ALTER TABLE scheduled_tasks ADD COLUMN memory_grant_ceiling TEXT NOT NULL DEFAULT 'none'
      CHECK (memory_grant_ceiling IN ('none', 'read', 'read_write'))
  `;
  yield* sql`
    ALTER TABLE remote_dispatches ADD COLUMN memory_grant_ceiling TEXT NOT NULL DEFAULT 'none'
      CHECK (memory_grant_ceiling IN ('none', 'read', 'read_write'))
  `;
});
