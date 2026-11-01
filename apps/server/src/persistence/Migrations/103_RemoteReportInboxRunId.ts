import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * The run a pending report was sent from, so a turn can tell a lane's report for this run from an
 * older one before it shortens that run's end notice. Null for rows from before this column and
 * for reports that have no run.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE remote_report_inbox ADD COLUMN run_id TEXT`;
});
