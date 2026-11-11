import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Pending outbox rows by when they are due, so a delivery claim reads only due rows however many
 * wait out a retry for later; channel_outbox_due_idx reads every open row to check that.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // The constant state column lets the planner prefer this index to channel_outbox_due_idx.
  yield* sql`CREATE INDEX IF NOT EXISTS channel_outbox_due_time_idx
    ON channel_outbox(state, next_attempt_at) WHERE state = 'pending'`;
});
