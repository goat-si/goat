import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { fenceWorkTriggerRollback } from "../reconcileGoatMigrationIds.ts";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const work = yield* sql`
    SELECT 1 FROM scheduled_tasks
      WHERE CASE WHEN json_valid(owner_json) THEN json_extract(owner_json, '$.routineMode') END = 'work'
    UNION ALL
    SELECT 1 FROM scheduled_task_channel_inputs
      WHERE CASE WHEN json_valid(payload_json) THEN json_extract(payload_json, '$.routineMode') END = 'work'
    UNION ALL
    SELECT 1 FROM channel_tasks
      WHERE CASE WHEN json_valid(task_json) THEN json_extract(task_json, '$.routineWork') END = 1
    LIMIT 1`;
  if (work.length > 0) yield* fenceWorkTriggerRollback();
});
