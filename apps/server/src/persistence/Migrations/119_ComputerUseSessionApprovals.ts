import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE computer_use_session_approvals (
    thread_id TEXT NOT NULL,
    app_key TEXT NOT NULL,
    created_sequence INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (thread_id, app_key)
  )`;
});
