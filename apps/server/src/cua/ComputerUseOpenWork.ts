/**
 * Whether a thread still has work open that its computer use control serves.
 *
 * @module ComputerUseOpenWork
 */
import type { ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * Whether the thread still has a run, provider turn or native subagent open. Native subagents
 * work through the parent's provider session, and so its control, on their own child threads;
 * one can outlive a failed parent run. Delegated tasks hold controls of their own.
 */
export const openRuns = Effect.fn("ComputerUseLeases.openWork")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const open = yield* sql<{ readonly one: number }>`
    WITH RECURSIVE native(child_thread_id, status) AS (
      SELECT s.child_thread_id, s.status FROM orchestration_v2_projection_subagents s
      WHERE s.thread_id = ${threadId} AND s.origin = 'provider_native'
      UNION
      SELECT s.child_thread_id, s.status FROM orchestration_v2_projection_subagents s
      JOIN native n ON s.thread_id = n.child_thread_id
      WHERE s.origin = 'provider_native'
    )
    SELECT 1 AS one FROM orchestration_v2_projection_runs
    WHERE thread_id = ${threadId}
      AND status IN ('preparing', 'queued', 'starting', 'running', 'waiting')
    UNION ALL
    SELECT 1 AS one FROM native WHERE status IN ('pending', 'running', 'waiting')
    UNION ALL
    SELECT 1 AS one FROM orchestration_v2_projection_provider_turns
    WHERE status IN ('pending', 'running')
      AND (thread_id = ${threadId} OR thread_id IN (SELECT child_thread_id FROM native))
    LIMIT 1
  `;
  return open.length > 0;
});
