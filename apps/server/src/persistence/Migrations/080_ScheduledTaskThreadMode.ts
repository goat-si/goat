import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // GOAT ledgers run this late, during id reconciliation. A rerun must not reset a chosen mode.
  const columns = yield* sql<{ readonly name: string }>`PRAGMA table_info(scheduled_tasks)`;
  if (columns.some((column) => column.name === "thread_mode")) return;
  yield* sql`ALTER TABLE scheduled_tasks ADD COLUMN thread_mode TEXT NOT NULL DEFAULT 'new_thread'`;
  yield* sql`UPDATE scheduled_tasks SET thread_mode = 'continue' WHERE thread_id IS NOT NULL`;
});
