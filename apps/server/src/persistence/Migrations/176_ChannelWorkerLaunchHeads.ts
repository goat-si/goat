import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE channel_worker_launch_heads (
    task_id TEXT NOT NULL REFERENCES channel_tasks(task_id) ON DELETE CASCADE,
    generation INTEGER NOT NULL,
    repository TEXT NOT NULL,
    branch TEXT NOT NULL,
    PRIMARY KEY (task_id, generation, repository, branch)
  )`;
  yield* sql`CREATE INDEX channel_worker_launch_heads_lookup
    ON channel_worker_launch_heads(repository, branch)`;
  yield* sql`CREATE INDEX scheduled_task_channel_inputs_active_task
    ON scheduled_task_channel_inputs(task_id) WHERE state <> 'settled'`;
});
