import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * An attach's request key: a digest of its caller and clientRequestId. A repeat with the same key
 * answers the stored record's status, never the invite token, which GOAT does not store.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE disposable_machines ADD COLUMN request_key TEXT`;
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS disposable_machines_request_key
    ON disposable_machines(request_key) WHERE request_key IS NOT NULL`;
});
