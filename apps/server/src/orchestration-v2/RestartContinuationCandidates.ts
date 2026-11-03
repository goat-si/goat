import { ThreadId, type OrchestrationV2ThreadProjection } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

export const selectRestartContinuationCandidates = (sql: SqlClient.SqlClient) =>
  sql<{ readonly thread_id: string }>`
  SELECT thread_id FROM orchestration_v2_projection_threads
  WHERE deleted_at IS NULL AND thread_id IN (
    SELECT thread_id FROM orchestration_v2_projection_runs WHERE status = 'starting'
    UNION
    SELECT runs.thread_id FROM orchestration_v2_projection_runs AS runs
    WHERE runs.status IN ('running', 'waiting', 'completed') AND runs.thread_id IN (
      SELECT bindings.thread_id FROM orchestration_v2_projection_provider_sessions AS sessions
      JOIN orchestration_v2_projection_provider_session_bindings AS bindings
        ON bindings.provider_session_id = sessions.provider_session_id
      WHERE sessions.status NOT IN ('stopped', 'error')
      UNION
      SELECT sessions.thread_id FROM orchestration_v2_projection_provider_sessions AS sessions
      WHERE sessions.status NOT IN ('stopped', 'error') AND sessions.thread_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM orchestration_v2_projection_provider_session_bindings AS bindings
          WHERE bindings.provider_session_id = sessions.provider_session_id)
    )
  ) ORDER BY updated_at ASC, thread_id ASC
`.pipe(Effect.map((rows) => rows.map((row) => ThreadId.make(row.thread_id))));

export const isRestartContinuationCandidate = (projection: OrchestrationV2ThreadProjection) =>
  projection.runs.some((run) => run.status === "starting") ||
  (projection.runs.some((run) => ["running", "waiting", "completed"].includes(run.status)) &&
    projection.providerSessions.some(
      (session) => session.status !== "stopped" && session.status !== "error",
    ));
