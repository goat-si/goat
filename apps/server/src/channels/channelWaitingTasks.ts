import type * as SqlClient from "effect/sql/SqlClient";

/**
 * A task that waits on a person: waiting for input, a running worker whose thread needs an
 * answer, approval, sign-in or resume (`observed.needsYou`), or finished work whose approval is
 * still open. The bots' waiting badges and the open asks list read this one definition.
 */
export const waitingTaskCondition = (sql: SqlClient.SqlClient) => sql`(status = 'waiting_input'
  OR (status = 'running' AND COALESCE(json_array_length(task_json, '$.observed.needsYou'), 0) > 0)
  OR (status IN ('completed', 'failed') AND EXISTS (
    SELECT 1 FROM json_each(task_json, '$.observed.needsYou')
    WHERE json_extract(value, '$.kind') = 'approval')))`;
