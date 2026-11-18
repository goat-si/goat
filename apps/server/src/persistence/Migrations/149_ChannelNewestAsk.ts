import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Stores each task's newest showable ask for the open asks index. The backfill mirrors
 * `waitingAsks` in channelWaitingTasks.ts as it stood here, and reads only object elements, so
 * a malformed task gets its readable asks' value or NULL and never fails the migration.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE channel_tasks ADD COLUMN newest_ask_at TEXT`;
  const running = sql`json_extract(task_json, '$.status') NOT IN ('completed', 'failed')`;
  yield* sql`UPDATE channel_tasks SET newest_ask_at = (
      SELECT MAX(asked_at) FROM (
        SELECT json_extract(question.value, '$.askedAt') AS asked_at
        FROM json_each(task_json, '$.openQuestions') AS question
        WHERE json_type(task_json, '$.openQuestions') = 'array' AND question.type = 'object'
          AND ${running}
        UNION ALL
        SELECT json_extract(need.value, '$.since')
        FROM json_each(task_json, '$.observed.needsYou') AS need
        WHERE json_type(task_json, '$.observed.needsYou') = 'array' AND need.type = 'object'
          AND CASE json_extract(need.value, '$.kind')
          WHEN 'approval' THEN json_type(need.value, '$.approval') = 'object'
          WHEN 'question' THEN json_type(need.value, '$.question') = 'object' AND ${running}
          WHEN 'sign_in' THEN ${running}
          WHEN 'usage_limit' THEN ${running}
          ELSE 0 END
      )
    )
    WHERE CASE WHEN json_valid(task_json) AND json_type(task_json) = 'object'
      THEN json_type(task_json, '$.openQuestions') = 'array'
        OR json_type(task_json, '$.observed.needsYou') = 'array'
      ELSE 0 END`;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_tasks_owner_newest_ask
    ON channel_tasks(owner_id, newest_ask_at, updated_at) WHERE newest_ask_at IS NOT NULL`;
});
