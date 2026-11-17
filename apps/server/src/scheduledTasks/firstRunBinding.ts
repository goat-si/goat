import { ProjectId, ScheduledTaskId, ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

import { ROUTINE_MESSAGE_PREFIX } from "./ScheduledTaskRuns.ts";

/**
 * One-thread tasks that a stop or a failed write left unbound after their first run launched,
 * each with the thread of its earliest firing. Only threads still in the task's project qualify.
 */
export const unboundFirstRunThreads = (sql: SqlClient.SqlClient) =>
  sql<{
    readonly task_id: string;
    readonly created_at: string;
    readonly project_id: string;
    readonly thread_id: string;
  }>`
    SELECT t.task_id, t.created_at, t.project_id, r.thread_id
    FROM scheduled_tasks t
    JOIN scheduled_task_runs r ON r.task_id = t.task_id AND r.task_created_at = t.created_at
    JOIN orchestration_v2_projection_threads th
      ON th.thread_id = r.thread_id AND th.project_id = t.project_id
    WHERE t.thread_id IS NULL AND t.thread_mode != 'new_thread'
      AND r.message_id NOT LIKE ${ROUTINE_MESSAGE_PREFIX + "%"}
    ORDER BY r.requested_at, r.firing_id
  `.pipe(
    Effect.map((rows) => {
      const first = new Map<string, (typeof rows)[number]>();
      for (const row of rows) if (!first.has(row.task_id)) first.set(row.task_id, row);
      return [...first.values()].map((row) => ({
        task: {
          id: ScheduledTaskId.make(row.task_id),
          createdAt: row.created_at,
          projectId: ProjectId.make(row.project_id),
        },
        threadId: ThreadId.make(row.thread_id),
      }));
    }),
  );
