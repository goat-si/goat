import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * Stores when each task's newest showable ask was made, so the open asks list reads its newest
 * candidates from an index. The backfill mirrors `waitingAsks` in channelWaitingTasks.ts as it
 * stood here: open questions while the task runs, and each need that names what to answer
 * (sign-in and usage limits name nothing); finished work keeps only its approvals.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE channel_tasks ADD COLUMN newest_ask_at TEXT`;
  const running = sql`json_extract(task_json, '$.status') NOT IN ('completed', 'failed')`;
  yield* sql`UPDATE channel_tasks SET newest_ask_at = (
      SELECT MAX(asked_at) FROM (
        SELECT json_extract(question.value, '$.askedAt') AS asked_at
        FROM json_each(task_json, '$.openQuestions') AS question WHERE ${running}
        UNION ALL
        SELECT json_extract(need.value, '$.since')
        FROM json_each(task_json, '$.observed.needsYou') AS need
        WHERE CASE json_extract(need.value, '$.kind')
          WHEN 'approval' THEN json_type(need.value, '$.approval') = 'object'
          WHEN 'question' THEN json_type(need.value, '$.question') = 'object' AND ${running}
          WHEN 'sign_in' THEN ${running}
          WHEN 'usage_limit' THEN ${running}
          ELSE 0 END
      )
    )
    WHERE json_valid(task_json)
      AND (json_array_length(task_json, '$.openQuestions') > 0
        OR json_array_length(task_json, '$.observed.needsYou') > 0)`;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_tasks_owner_newest_ask
    ON channel_tasks(owner_id, newest_ask_at, updated_at) WHERE newest_ask_at IS NOT NULL`;
});
