import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * An attach's progress after Pen admits the machine: each step's last outcome, the stop that holds
 * it, and when the link operation's intent was written (OpenCodex replays an operation id's answer
 * for 2 hours, so the age decides whether an unknown id may be sent again). Fixed codes only.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE disposable_machines ADD COLUMN enroll_json TEXT NOT NULL DEFAULT '{}'`;
});
