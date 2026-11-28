import type { MessageId, ThreadId } from "@goat/contracts";
import type * as SqlClient from "effect/sql/SqlClient";
import { DEFERRED_COMMAND_MESSAGE_CONDITION } from "./deferredCommandMessage.ts";

export const turnStartMessages = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  memoryMessageIds: ReadonlyArray<MessageId>,
) => sql<{ readonly payload_json: string }>`
  SELECT payload_json FROM (
    SELECT payload_json, created_at, message_id FROM orchestration_v2_projection_messages
    WHERE thread_id = ${threadId} AND (
      message_id IN ${sql.in(memoryMessageIds)} OR message_id IN (
        SELECT json_extract(r.payload_json, '$.userMessageId') FROM orchestration_v2_projection_runs r
        JOIN orchestration_v2_projection_context_handoffs h ON h.target_run_id = r.run_id
        WHERE r.thread_id = ${threadId} AND h.thread_id = ${threadId} AND h.status = 'ready'
          AND json_extract(h.payload_json, '$.delivery') IS NULL
      )
    )
    UNION
    SELECT payload_json, created_at, message_id FROM orchestration_v2_projection_messages
    WHERE thread_id = ${threadId} AND ${sql.literal(DEFERRED_COMMAND_MESSAGE_CONDITION)}
  ) ORDER BY created_at ASC, message_id ASC
`;
