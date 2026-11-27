import type { ThreadId } from "@goat/contracts";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as Statement from "effect/sql/Statement";

export function providerThreadOwnershipFilter(
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  ownedNodes: Statement.Fragment,
  unsettled: Statement.Fragment,
  omitSettled: boolean,
) {
  return omitSettled
    ? // A dispatcher's settled tasks' provider threads belong to the child threads;
      // only a session this thread also uses is probed when it detaches. Most rows
      // lack an owner or session, so ANALYZE rates those indexes as matching every
      // row and SQLite scans for an OR of them; each union branch seeks instead.
      sql`rowid IN (
              SELECT rowid FROM orchestration_v2_projection_provider_threads
              WHERE thread_id = ${threadId}
              UNION
              SELECT rowid FROM orchestration_v2_projection_provider_threads
                INDEXED BY orchestration_v2_projection_provider_threads_owner_idx
              WHERE owner_node_id IN (${ownedNodes})
              UNION
              SELECT rowid FROM orchestration_v2_projection_provider_threads
              WHERE provider_thread_id IN (
                SELECT provider_thread_id
                FROM orchestration_v2_projection_subagents
                WHERE rowid IN (${unsettled})
                  AND provider_thread_id IS NOT NULL
              )
              UNION
              SELECT rowid FROM orchestration_v2_projection_provider_threads AS shared
                INDEXED BY orchestration_v2_projection_provider_threads_session_idx
              WHERE provider_session_id IN (
                  SELECT provider_session_id
                  FROM orchestration_v2_projection_provider_session_bindings
                  WHERE thread_id = ${threadId}
                )
                AND EXISTS (
                  SELECT 1 FROM orchestration_v2_projection_subagents AS owner
                  WHERE owner.provider_thread_id = shared.provider_thread_id
                    AND owner.thread_id = ${threadId}
                )
            )`
    : sql`(thread_id = ${threadId}
               OR owner_node_id IN (${ownedNodes})
               OR provider_thread_id IN (
                 SELECT provider_thread_id
                 FROM orchestration_v2_projection_subagents
                 WHERE thread_id = ${threadId}
                   AND provider_thread_id IS NOT NULL
               ))`;
}
