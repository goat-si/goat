import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Reads a bot's finished work tasks newest first, by finish time and task id, for the paged
 * bot-thread list. Its expression and terms must match that query's for SQLite to use it. A task stored without completedAt sorts by
 * updated_at, which a later observation can still move.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_tasks_owner_bot_finished ON channel_tasks(
      owner_id, bot_id, COALESCE(json_extract(task_json, '$.completedAt'), updated_at), task_id)
    WHERE status IN ('completed', 'failed', 'cancelled')
      AND COALESCE(json_extract(task_json, '$.kind'), 'work') != 'turn'`;
});
