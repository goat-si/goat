import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tasks = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (!tasks.some((c) => c.name === "notification_policy"))
    yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN notification_policy TEXT NOT NULL DEFAULT 'all_runs'`;
  const runs = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(orchestration_v2_projection_runs)`;
  if (!runs.some((c) => c.name === "completion_notification"))
    yield* sql`ALTER TABLE orchestration_v2_projection_runs ADD COLUMN completion_notification TEXT`;
  // Fold event metadata as well: a reopened legacy run no longer carries its earlier completion.
  yield* sql`WITH eligible AS (
    SELECT thread_id, completed_at FROM orchestration_v2_projection_runs
      WHERE completed_at IS NOT NULL AND completion_notification IS NOT 'silent'
    UNION ALL
    SELECT stream_id, json_extract(payload_json, '$.completedAt') FROM orchestration_events
      WHERE application_event_version = 2 AND aggregate_kind = 'thread'
        AND event_type IN ('run.created', 'run.updated')
        AND json_type(payload_json, '$.completedAt') = 'text'
        AND json_extract(payload_json, '$.completionNotification') IS NOT 'silent'
  ), cursors AS (
    SELECT thread_id, max(completed_at) AS completed_at FROM eligible GROUP BY thread_id
  ) UPDATE orchestration_v2_projection_threads SET payload_json = json_set(payload_json,
    '$.notificationCompletedAt', (SELECT c.completed_at FROM cursors c
      WHERE c.thread_id = orchestration_v2_projection_threads.thread_id))
    WHERE json_type(payload_json, '$.notificationCompletedAt') IS NULL`;
});
