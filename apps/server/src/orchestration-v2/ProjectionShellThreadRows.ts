import { IDLE_COMPACTION_TEXT, type ThreadId } from "@goat/contracts";
import type * as SqlClient from "effect/sql/SqlClient";
import type { ShellSnapshotOptions } from "./ProjectionStore.ts";

export type ShellThreadRow = {
  readonly thread_id: string;
  readonly payload_json: string;
  readonly forked_from_run_source_thread_id: string | null;
  readonly latest_run_id: string | null;
  readonly latest_run_status: string | null;
  readonly latest_run_requested_at: string | null;
  readonly latest_run_started_at: string | null;
  readonly latest_run_completed_at: string | null;
  readonly latest_run_completion_notification: string | null;
  readonly blocking_run_completion_notification: string | null;
  readonly latest_run_stop_requested: number;
  readonly active_run_id: string | null;
  readonly active_run_status: string | null;
  readonly activity_run_status: string | null;
  readonly activity_run_started_at: string | null;
  readonly last_error: string | null;
  readonly terminal_failure_payload_json: string | null;
  readonly blocking_run_id: string | null;
  readonly blocking_run_requested_at: string | null;
  readonly blocking_run_started_at: string | null;
  readonly blocking_run_completed_at: string | null;
  readonly blocking_run_stop_requested: number;
  readonly blocking_failure_payload_json: string | null;
  readonly pending_request_payload_json: string | null;
  readonly pending_secret_request_payload_json: string | null;
  readonly latest_user_message_at: string | null;
  readonly latest_user_authored_message_at: string | null;
  readonly has_actionable_proposed_plan: number;
};

// SQL fragments share the enclosing projection operation's span.
export const makeShellThreadRows = (sql: SqlClient.SqlClient) => {
  // Mirror idleCompactionOf, including JavaScript trim whitespace.
  const isIdleCompactionMessage = (alias: string) => {
    const payload = sql.literal(`${alias}.payload_json`);
    return sql`(
        ${sql.literal(`${alias}.role`)} = 'user'
        AND lower(trim(json_extract(${payload}, '$.text'),
          char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195,
            8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)
        )) = ${IDLE_COMPACTION_TEXT}
        AND coalesce(json_array_length(${payload}, '$.attachments'), 0) = 0
        AND (
          json_extract(${payload}, '$.idleCompaction') IS NOT NULL
          OR (
            json_extract(${payload}, '$.createdBy') = 'agent'
            AND json_extract(${payload}, '$.creationSource') = 'server'
          )
        )
      )`;
  };
  // Mirrors isIdleCompactionRun: prompted by an idle compaction whose compaction did not fail.
  const isIdleCompactionRun = (alias: string) => {
    const run = sql.literal(alias);
    return sql`(
        EXISTS (
          SELECT 1 FROM orchestration_v2_projection_messages prompt
          WHERE prompt.message_id = json_extract(${run}.payload_json, '$.userMessageId')
            AND ${isIdleCompactionMessage("prompt")}
        ) AND NOT EXISTS (
          SELECT 1 FROM orchestration_v2_projection_turn_items compaction
          WHERE compaction.thread_id = ${run}.thread_id AND compaction.run_id = ${run}.run_id
            AND compaction.type = 'compaction'
            AND compaction.status = 'failed'
        )
      )`;
  };
  // Mirrors isSilentRunForShell.
  const isSilentShellRun = (alias: string) =>
    sql`(${sql.literal(alias)}.status <> 'failed' AND ${isIdleCompactionRun(alias)})`;

  const selectShellThreadRows = (
    threadId?: ThreadId,
    {
      location,
      projectId,
      unsettledOnly = false,
      familyOf,
      worktreePath,
      threadIds,
    }: ShellSnapshotOptions = {},
  ) =>
    sql<ShellThreadRow>`
            SELECT
              t.thread_id,
              t.payload_json,
              CASE
                WHEN json_extract(t.payload_json, '$.forkedFrom.type') = 'run'
                  THEN json_extract(t.payload_json, '$.forkedFrom.threadId')
                ELSE NULL
              END AS forked_from_run_source_thread_id,
              presented.run_id AS latest_run_id,
              presented.status AS latest_run_status,
              presented.requested_at AS latest_run_requested_at,
              json_extract(presented.payload_json, '$.startedAt') AS latest_run_started_at,
              presented.completed_at AS latest_run_completed_at,
              json_extract(presented.payload_json,'$.completionNotification') AS latest_run_completion_notification,
              json_extract(blocked.payload_json,'$.completionNotification') AS blocking_run_completion_notification,
              EXISTS (
                SELECT 1 FROM orchestration_v2_projection_turn_items stop_request
                WHERE stop_request.thread_id = t.thread_id AND stop_request.run_id = presented.run_id
                  AND stop_request.type = 'run_interrupt_request'
              ) AS latest_run_stop_requested,
              active.run_id AS active_run_id,
              active.status AS active_run_status,
              (
                SELECT r.status
                FROM orchestration_v2_projection_runs r
                WHERE r.thread_id = t.thread_id
                  AND r.status IN ('preparing', 'starting', 'running', 'waiting')
                  AND NOT ${isSilentShellRun("r")}
                ORDER BY r.ordinal DESC, r.run_id DESC
                LIMIT 1
              ) AS activity_run_status,
              (
                -- Mirrors orchestrationV2RunWorkStartedAt.
                SELECT COALESCE(
                  json_extract(r.payload_json, '$.workStartedAt'),
                  json_extract(r.payload_json, '$.startedAt'),
                  r.requested_at
                )
                FROM orchestration_v2_projection_runs r
                WHERE r.thread_id = t.thread_id
                  AND r.status IN ('preparing', 'starting', 'running', 'waiting')
                  AND NOT ${isSilentShellRun("r")}
                ORDER BY r.ordinal DESC, r.run_id DESC
                LIMIT 1
              ) AS activity_run_started_at,
              (
                SELECT json_extract(session.payload_json, '$.lastError')
                -- Keep bindings outermost: one provider instance can hold every session.
                FROM orchestration_v2_projection_provider_session_bindings binding
                CROSS JOIN orchestration_v2_projection_provider_sessions session
                  ON session.provider_session_id = binding.provider_session_id
                WHERE binding.thread_id = t.thread_id
                  AND session.provider_instance_id = t.provider_instance_id
                ORDER BY session.updated_at DESC, session.provider_session_id DESC
                LIMIT 1
              ) AS last_error,
              (
                SELECT item.payload_json
                FROM orchestration_v2_projection_turn_items item
                INNER JOIN orchestration_v2_projection_runs r ON r.run_id = item.run_id
                WHERE r.run_id = presented.run_id
                  AND r.status = 'failed'
                  AND item.thread_id = t.thread_id
                  AND item.type = 'error' AND item.status = 'failed'
                  AND item.node_id IS json_extract(r.payload_json, '$.rootNodeId')
                ORDER BY item.updated_at DESC, item.ordinal DESC, item.turn_item_id DESC
                LIMIT 1
              ) AS terminal_failure_payload_json,
              blocked.run_id AS blocking_run_id,
              blocked.requested_at AS blocking_run_requested_at,
              json_extract(blocked.payload_json, '$.startedAt') AS blocking_run_started_at,
              blocked.completed_at AS blocking_run_completed_at,
              EXISTS (
                SELECT 1 FROM orchestration_v2_projection_turn_items stop_request
                WHERE stop_request.thread_id = t.thread_id AND stop_request.run_id = blocked.run_id
                  AND stop_request.type = 'run_interrupt_request'
              ) AS blocking_run_stop_requested,
              (
                SELECT item.payload_json
                FROM orchestration_v2_projection_turn_items item
                WHERE item.thread_id = t.thread_id
                  AND item.run_id = blocked.run_id
                  AND item.type = 'error' AND item.status = 'failed'
                  AND item.node_id IS json_extract(blocked.payload_json, '$.rootNodeId')
                ORDER BY item.updated_at DESC, item.ordinal DESC, item.turn_item_id DESC
                LIMIT 1
              ) AS blocking_failure_payload_json,
              COALESCE(
                (
                  SELECT request.payload_json
                  FROM orchestration_v2_projection_runtime_requests request
                  WHERE request.thread_id = t.thread_id
                    AND request.status = 'pending'
                    AND request.kind NOT IN ('auth_refresh', 'dynamic_tool_call')
                  ORDER BY request.created_at DESC, request.runtime_request_id DESC
                  LIMIT 1
                ),
                (
                  SELECT request.payload_json
                  FROM orchestration_v2_projection_runtime_requests request
                  WHERE request.thread_id = t.thread_id
                    AND request.status = 'pending'
                  ORDER BY request.created_at DESC, request.runtime_request_id DESC
                  LIMIT 1
                )
              ) AS pending_request_payload_json,
              COALESCE((
                SELECT secret.payload_json
                -- Keep runs outermost so completed history is never scanned for a pending secret.
                FROM orchestration_v2_projection_runs r
                CROSS JOIN orchestration_v2_projection_turn_items secret
                  INDEXED BY orchestration_v2_projection_turn_items_thread_run_idx
                WHERE r.thread_id = t.thread_id
                  AND r.status IN ('preparing', 'starting', 'running', 'waiting')
                  AND secret.thread_id = t.thread_id AND secret.run_id = r.run_id
                  AND secret.type = 'secret_request' AND secret.status = 'waiting'
                ORDER BY secret.updated_at DESC, secret.turn_item_id DESC
                LIMIT 1
              ), (
                SELECT handoff.payload_json
                FROM orchestration_v2_projection_turn_items handoff
                WHERE handoff.thread_id = t.thread_id
                  AND handoff.type IN ('human_handoff', 'secret_request')
                  AND handoff.type = 'human_handoff' AND handoff.status = 'waiting'
                ORDER BY handoff.updated_at DESC, handoff.turn_item_id DESC
                LIMIT 1
              )) AS pending_secret_request_payload_json,
              (
                SELECT message.updated_at
                FROM orchestration_v2_projection_messages message
                WHERE message.thread_id = t.thread_id
                  AND message.role = 'user'
                  AND NOT ${isIdleCompactionMessage("message")}
                ORDER BY message.updated_at DESC, message.message_id DESC
                LIMIT 1
              ) AS latest_user_message_at,
              (
                SELECT message.updated_at
                FROM orchestration_v2_projection_messages message
                WHERE message.thread_id = t.thread_id
                  AND message.role = 'user'
                  AND json_extract(message.payload_json, '$.createdBy') = 'user'
                ORDER BY message.updated_at DESC, message.message_id DESC
                LIMIT 1
              ) AS latest_user_authored_message_at,
              EXISTS (
                SELECT 1
                FROM orchestration_v2_projection_plans plan
                WHERE plan.thread_id = t.thread_id
                  AND plan.kind = 'proposed_plan'
                  AND plan.status = 'active'
              ) AS has_actionable_proposed_plan
            FROM orchestration_v2_projection_threads t
            LEFT JOIN orchestration_v2_projection_runs active ON active.run_id = (
              SELECT r.run_id
              FROM orchestration_v2_projection_runs r
              WHERE r.thread_id = t.thread_id
                AND r.status IN ('preparing', 'starting', 'running')
                AND NOT ${isSilentShellRun("r")}
              ORDER BY r.ordinal DESC, r.run_id DESC
              LIMIT 1
            )
            -- The newest run not waiting in a held queue, matching latestUnheldRun.
            LEFT JOIN orchestration_v2_projection_runs presented ON presented.run_id = (
              SELECT candidate.run_id
              FROM orchestration_v2_projection_runs candidate
              WHERE candidate.thread_id = t.thread_id
                AND NOT (
                  candidate.status = 'queued'
                  AND json_extract(candidate.payload_json, '$.queueHeld') IS 1
                )
                AND NOT ${isSilentShellRun("candidate")}
              ORDER BY candidate.ordinal DESC, candidate.run_id DESC
              LIMIT 1
            )
            LEFT JOIN orchestration_v2_projection_runs blocked ON blocked.run_id = (
              SELECT candidate.run_id
              FROM orchestration_v2_projection_runs candidate
              WHERE candidate.thread_id = t.thread_id
                AND candidate.status <> 'queued'
                AND NOT (
                  candidate.status = 'cancelled'
                  AND json_extract(candidate.payload_json, '$.startedAt') IS NULL
                )
              -- latestExecutedRun: the run that ended last (runRanAfter).
              ORDER BY candidate.completed_at IS NULL DESC, candidate.completed_at DESC,
                candidate.ordinal DESC, candidate.run_id DESC
              LIMIT 1
            ) AND blocked.status = 'failed'
            WHERE t.deleted_at IS NULL${threadId === undefined ? sql`` : sql` AND t.thread_id = ${threadId}`}${
              projectId === undefined ? sql`` : sql` AND t.project_id = ${projectId}`
            }${
              location === "active"
                ? sql` AND json_extract(t.payload_json, '$.archivedAt') IS NULL`
                : location === "archive"
                  ? sql` AND json_extract(t.payload_json, '$.archivedAt') IS NOT NULL`
                  : sql``
            }${
              unsettledOnly
                ? sql` AND json_extract(t.payload_json, '$.settledAt') IS NULL AND json_extract(t.payload_json, '$.settledOverride') IS NOT 'settled'`
                : sql``
            }${
              familyOf === undefined
                ? sql``
                : sql` AND json_extract(t.payload_json, '$.lineage.rootThreadId') = (
                    SELECT json_extract(member.payload_json, '$.lineage.rootThreadId')
                    FROM orchestration_v2_projection_threads member
                    WHERE member.thread_id = ${familyOf}
                  )`
            }${
              worktreePath === undefined
                ? sql``
                : sql` AND json_extract(t.payload_json, '$.worktreePath') = ${worktreePath}`
            }${threadIds === undefined ? sql`` : sql` AND t.thread_id IN ${sql.in(threadIds)}`}
            ORDER BY t.updated_at ASC, t.thread_id ASC
          `;
  return { selectShellThreadRows, isIdleCompactionMessage, isIdleCompactionRun, isSilentShellRun };
};
