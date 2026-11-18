import type { OrchestrationV2ProviderThread, RunId } from "@goat/contracts";
import type * as SqlClient from "effect/sql/SqlClient";

export function upsertProviderThreadProjection(
  sql: SqlClient.SqlClient,
  providerThread: OrchestrationV2ProviderThread,
  payloadJson: string,
  updatedAt: string,
) {
  return sql`
    INSERT INTO orchestration_v2_projection_provider_threads (
      provider_thread_id,
      thread_id,
      owner_node_id,
      provider,
      driver,
      provider_instance_id,
      provider_session_id,
      status,
      first_run_ordinal,
      last_run_ordinal,
      updated_at,
      payload_json
    )
    VALUES (
      ${providerThread.id},
      ${providerThread.appThreadId},
      ${providerThread.ownerNodeId},
      ${providerThread.providerInstanceId},
      ${providerThread.driver},
      ${providerThread.providerInstanceId},
      ${providerThread.providerSessionId},
      ${providerThread.status},
      ${providerThread.firstRunOrdinal},
      ${providerThread.lastRunOrdinal},
      ${updatedAt},
      ${payloadJson}
    )
    ON CONFLICT(provider_thread_id)
    DO UPDATE SET
      thread_id = excluded.thread_id,
      owner_node_id = excluded.owner_node_id,
      provider = excluded.provider,
      driver = excluded.driver,
      provider_instance_id = excluded.provider_instance_id,
      provider_session_id = excluded.provider_session_id,
      status = excluded.status,
      first_run_ordinal = excluded.first_run_ordinal,
      last_run_ordinal = excluded.last_run_ordinal,
      updated_at = excluded.updated_at,
      payload_json = excluded.payload_json
  `;
}

// Adapters resend whole rosters. Keep an unstamped entry unattributed once observed.
export function attributePendingBackgroundTasks(
  next: OrchestrationV2ProviderThread,
  previous: Pick<OrchestrationV2ProviderThread, "pendingBackgroundTasks"> | undefined,
  runId: RunId | null | undefined,
): OrchestrationV2ProviderThread {
  const tasks = next.pendingBackgroundTasks ?? [];
  if (tasks.every((task) => task.runId !== undefined)) return next;
  const known = new Map(previous?.pendingBackgroundTasks?.map((task) => [task.taskId, task.runId]));
  return {
    ...next,
    pendingBackgroundTasks: tasks.map((task) => {
      if (task.runId !== undefined) return task;
      const owner = known.has(task.taskId) ? known.get(task.taskId) : runId;
      return owner == null ? task : { ...task, runId: owner };
    }),
  };
}
