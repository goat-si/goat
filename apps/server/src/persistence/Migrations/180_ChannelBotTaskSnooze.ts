import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE channel_tasks ADD COLUMN status_version INTEGER NOT NULL DEFAULT 0`;
  yield* sql`CREATE TRIGGER channel_task_status_version AFTER UPDATE OF status ON channel_tasks
    WHEN NEW.status != OLD.status
    BEGIN
      UPDATE channel_tasks SET status_version = OLD.status_version + 1 WHERE task_id = NEW.task_id;
    END`;
  yield* sql`CREATE INDEX channel_task_views_by_task ON channel_runtime_state (
    json_valid(value_json),
    CASE WHEN json_valid(value_json) THEN json_extract(value_json, '$.taskId') END,
    key
  ) WHERE key >= 'task-view:' AND key < 'task-view;'`;
  yield* sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
    VALUES ('bot-task-activity-since', '{}', strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;
});
