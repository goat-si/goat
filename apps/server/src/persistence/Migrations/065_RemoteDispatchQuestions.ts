import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** The remote task's open questions, a JSON array of request ids, as last observed. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE remote_dispatches ADD COLUMN pending_request_ids TEXT`;
});
