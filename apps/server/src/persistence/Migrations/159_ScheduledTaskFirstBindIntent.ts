import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_task_runs)`;
  if (!columns.some((column) => column.name === "first_bind_project_id")) {
    yield* sql`ALTER TABLE scheduled_task_runs ADD COLUMN first_bind_project_id TEXT`;
  }
  // An edit away from a destination invalidates the intent even if the task is edited back.
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS scheduled_task_first_bind_destination_changed
    AFTER UPDATE OF project_id, thread_mode ON scheduled_tasks
    WHEN OLD.project_id != NEW.project_id OR (OLD.thread_mode != 'new_thread' AND NEW.thread_mode = 'new_thread')
    BEGIN
      UPDATE scheduled_task_runs SET first_bind_project_id = NULL
      WHERE firing_id = OLD.last_firing_id AND task_id = OLD.task_id AND task_created_at = OLD.created_at;
    END
  `;
});
