import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

// 110 as shipped and the server before it counted GOAT's own successful idle compactions toward the
// unread cursor. Frozen copy of the shell's rule: an idle /compact stays read unless it fails.
const quietIdleCompaction = (
  sql: SqlClient.SqlClient,
  input: {
    readonly thread: string;
    readonly run: string;
    readonly status: string;
    readonly prompt: string;
  },
) => sql`(
  ${sql.literal(input.status)} IS NOT 'failed'
  AND EXISTS (
    SELECT 1 FROM orchestration_v2_projection_messages prompt
    WHERE prompt.message_id = ${sql.literal(input.prompt)} AND prompt.role = 'user'
      AND lower(trim(json_extract(prompt.payload_json, '$.text'),
        char(9, 10, 11, 12, 13, 32, 160, 5760, 8192, 8193, 8194, 8195,
          8196, 8197, 8198, 8199, 8200, 8201, 8202, 8232, 8233, 8239, 8287, 12288, 65279)
      )) = '/compact'
      AND coalesce(json_array_length(prompt.payload_json, '$.attachments'), 0) = 0
      AND (
        json_extract(prompt.payload_json, '$.idleCompaction') IS NOT NULL
        OR (
          json_extract(prompt.payload_json, '$.createdBy') = 'agent'
          AND json_extract(prompt.payload_json, '$.creationSource') = 'server'
        )
      )
  ) AND NOT EXISTS (
    SELECT 1 FROM orchestration_v2_projection_turn_items compaction
    WHERE compaction.thread_id = ${sql.literal(input.thread)}
      AND compaction.run_id = ${sql.literal(input.run)}
      AND compaction.type = 'compaction' AND compaction.status = 'failed'
  )
)`;

// Only a cursor that a quiet completion explains and no notifying completion shares moves, and only
// back to the latest notifying completion (or null), so healthy cursors and reruns stay untouched.
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`WITH completions AS MATERIALIZED (
    SELECT r.thread_id AS thread_id, r.completed_at AS completed_at,
      ${quietIdleCompaction(sql, {
        thread: "r.thread_id",
        run: "r.run_id",
        status: "r.status",
        prompt: "json_extract(r.payload_json, '$.userMessageId')",
      })} AS quiet
    FROM orchestration_v2_projection_runs r
    WHERE r.completed_at IS NOT NULL AND r.completion_notification IS NOT 'silent'
    UNION ALL
    SELECT e.stream_id, json_extract(e.payload_json, '$.completedAt'),
      ${quietIdleCompaction(sql, {
        thread: "e.stream_id",
        run: "json_extract(e.payload_json, '$.id')",
        status: "json_extract(e.payload_json, '$.status')",
        prompt: "json_extract(e.payload_json, '$.userMessageId')",
      })}
    FROM orchestration_events e
    WHERE e.application_event_version = 2 AND e.aggregate_kind = 'thread'
      AND e.event_type IN ('run.created', 'run.updated')
      AND json_type(e.payload_json, '$.completedAt') = 'text'
      AND json_extract(e.payload_json, '$.completionNotification') IS NOT 'silent'
  ), repairs AS MATERIALIZED (
    SELECT c.thread_id AS thread_id,
      json_extract(t.payload_json, '$.notificationCompletedAt') AS current,
      max(CASE WHEN c.quiet THEN NULL ELSE c.completed_at END) AS eligible,
      max(c.quiet AND c.completed_at = json_extract(t.payload_json, '$.notificationCompletedAt')) AS quiet_hit,
      max(NOT c.quiet AND c.completed_at = json_extract(t.payload_json, '$.notificationCompletedAt')) AS eligible_hit
    FROM completions c
    JOIN orchestration_v2_projection_threads t ON t.thread_id = c.thread_id
    WHERE json_type(t.payload_json, '$.notificationCompletedAt') = 'text'
    GROUP BY c.thread_id
  )
  UPDATE orchestration_v2_projection_threads
  SET payload_json = json_set(payload_json, '$.notificationCompletedAt', repairs.eligible)
  FROM repairs
  WHERE repairs.thread_id = orchestration_v2_projection_threads.thread_id
    AND repairs.quiet_hit = 1 AND repairs.eligible_hit = 0
    AND (repairs.eligible IS NULL OR repairs.eligible < repairs.current)`;
});
