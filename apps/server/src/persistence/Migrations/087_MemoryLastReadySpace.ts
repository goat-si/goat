import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // One local browsing destination, independent of sharing and sync timestamps.
  yield* sql`CREATE TABLE memory_last_ready_space (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1),
    space TEXT NOT NULL
  )`;
});
