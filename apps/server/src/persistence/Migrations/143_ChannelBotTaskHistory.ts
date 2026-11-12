import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/** Walks a bot's tasks by creation for its history pages; neither column changes after insert. */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  // Built by an earlier draft of this migration on development databases only.
  yield* sql`DROP INDEX IF EXISTS channel_tasks_owner_bot_finished`;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_tasks_owner_bot_created
    ON channel_tasks(owner_id, bot_id, created_at, task_id)`;
});
