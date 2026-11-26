import type { ChannelInputId, ChannelTaskId, ChannelTaskEventId } from "@goat/contracts";
import {
  answerForwardIdsFor,
  toolSteerIdsFor,
  turnSteerIdsFor,
  workerLaunchIdsFor,
} from "../../channels/channelIds.ts";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export const conversationMemoryExcludedMessagesSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE conversation_memory_excluded_messages (
    thread_id TEXT NOT NULL,
    message_id TEXT NOT NULL,
    PRIMARY KEY (thread_id, message_id)
  ) WITHOUT ROWID`;
});

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* conversationMemoryExcludedMessagesSchema;
  // Compaction can discard an intermediate edit. Keep its identity independently of its text.
  yield* sql`CREATE TRIGGER conversation_memory_mark_paused_message AFTER INSERT ON orchestration_events
    WHEN NEW.event_type='message.updated' AND NEW.application_event_version=2 AND NEW.aggregate_kind='thread'
      AND (SELECT enabled FROM conversation_memory_policy ORDER BY generation DESC LIMIT 1)=0
    BEGIN
      INSERT OR IGNORE INTO conversation_memory_excluded_messages(thread_id, message_id)
      SELECT NEW.stream_id, json_extract(NEW.payload_json, '$.id')
      WHERE json_extract(NEW.payload_json, '$.id') IS NOT NULL;
    END`;
  yield* sql`CREATE TRIGGER conversation_memory_delete_thread AFTER INSERT ON orchestration_events
    WHEN NEW.event_type='thread.deleted' AND NEW.application_event_version=2 AND NEW.aggregate_kind='thread'
    BEGIN
      DELETE FROM conversation_memory_excluded_messages WHERE thread_id=NEW.stream_id;
    END`;
  // New installations and 186 environments that never paused need no transcript reads.
  if (!(yield* sql`SELECT 1 FROM conversation_memory_policy LIMIT 1`).length) return;
  const intervals = sql`SELECT enabled, after_sequence, lead(after_sequence) OVER (ORDER BY generation) AS until_sequence
    FROM conversation_memory_policy`;
  yield* sql`WITH intervals AS (${intervals})
    INSERT OR IGNORE INTO conversation_memory_excluded_messages(thread_id, message_id)
    SELECT e.stream_id, json_extract(e.payload_json,'$.id') FROM intervals i CROSS JOIN orchestration_events e
    WHERE i.enabled=0 AND e.sequence>i.after_sequence AND e.sequence<=coalesce(i.until_sequence,9223372036854775807)
      AND e.application_event_version=2 AND e.aggregate_kind='thread' AND e.event_type='message.updated'
      AND json_extract(e.payload_json,'$.id') IS NOT NULL`;
  // A channel input can precede its orchestration message by a pause and resume.
  yield* sql`INSERT OR IGNORE INTO conversation_memory_excluded_messages(thread_id, message_id)
    SELECT r.thread_id,r.message_id FROM channel_bot_session_runs r JOIN channel_tasks t ON t.task_id=r.task_id
    JOIN channel_inbox i ON i.input_id=json_extract(t.task_json,'$.originInputId')
    WHERE i.conversation_memory_enabled=0`;
  const workers = yield* sql<{ task_id: ChannelTaskId; generation: number }>`
    SELECT t.task_id,json_extract(c.value_json,'$.generation') AS generation FROM channel_runtime_state c
    JOIN channel_tasks t ON t.task_id=json_extract(c.value_json,'$.taskId')
    JOIN channel_inbox i ON i.input_id=json_extract(t.task_json,'$.originInputId')
    WHERE c.key GLOB 'channel-worker-context:*' AND i.conversation_memory_enabled=0`;
  for (const worker of workers) {
    const launch = workerLaunchIdsFor(worker.task_id, worker.generation);
    yield* sql`INSERT OR IGNORE INTO conversation_memory_excluded_messages(thread_id, message_id)
      SELECT thread_id,message_id FROM orchestration_v2_projection_messages
      WHERE thread_id=${launch.threadId} AND message_id=${launch.messageId}`;
  }
  // Forwarding IDs are deterministic for session and local worker turns, including note-free
  // follow-ups that never needed a separate sender receipt. Only mark messages actually sent.
  let after = 0;
  while (true) {
    const page = yield* sql<{
      sequence: number;
      type: string;
      event_id: ChannelTaskEventId;
      input_id: ChannelInputId;
      forward_key: string | null;
    }>`SELECT e.sequence,e.type,e.event_id,json_extract(e.event_json,'$.payload.inputId') AS input_id,
        json_extract(e.event_json,'$.payload.forwardKey') AS forward_key
      FROM channel_task_events e JOIN channel_tasks t ON t.task_id=e.task_id
      WHERE e.sequence>${after} AND e.type IN ('task.followup.received','task.question.answered')
        AND EXISTS(SELECT 1 FROM channel_inbox i WHERE i.conversation_memory_enabled=0 AND i.input_id IN (
          json_extract(t.task_json,'$.originInputId'),json_extract(e.event_json,'$.payload.sender.inputId'),
          CASE WHEN json_extract(e.event_json,'$.actor')='user' THEN json_extract(e.event_json,'$.payload.inputId') END))
      ORDER BY e.sequence LIMIT 100`;
    if (!page.length) break;
    const ids = page.flatMap((event) =>
      event.type === "task.question.answered"
        ? [answerForwardIdsFor(event.event_id).messageId]
        : (["first", "queued"] as const).map((attempt) =>
            event.forward_key === null
              ? turnSteerIdsFor(event.input_id, attempt).messageId
              : toolSteerIdsFor(event.forward_key, attempt).messageId,
          ),
    );
    yield* sql`INSERT OR IGNORE INTO conversation_memory_excluded_messages(thread_id, message_id)
      SELECT thread_id,message_id FROM orchestration_v2_projection_messages WHERE message_id IN ${sql.in(ids)}`;
    after = page[page.length - 1]?.sequence ?? after;
  }
  // In a compacted preview database the missing revision's ID cannot be recovered. Only a
  // message present on both sides of an incomplete pause window could have lost such an edit.
  const missingIntervals = sql`SELECT after_sequence, until_sequence FROM (${intervals}) i
    WHERE enabled=0 AND until_sequence-after_sequence > (
      SELECT count(*) FROM orchestration_events WHERE sequence>i.after_sequence AND sequence<=i.until_sequence)`;
  if ((yield* sql`SELECT 1 FROM (${missingIntervals}) LIMIT 1`).length) {
    yield* sql`WITH gaps AS MATERIALIZED (${missingIntervals}), versions AS (
      SELECT stream_id, json_extract(payload_json, '$.id') AS id, min(sequence) AS first, max(sequence) AS last
      FROM orchestration_events WHERE event_type='message.updated' AND application_event_version=2 AND aggregate_kind='thread'
      GROUP BY stream_id, json_extract(payload_json,'$.id') HAVING count(*)>1
    )
    INSERT OR IGNORE INTO conversation_memory_excluded_messages(thread_id, message_id)
    SELECT stream_id,id FROM versions WHERE id IS NOT NULL AND EXISTS (
      SELECT 1 FROM gaps WHERE first<=after_sequence AND last>until_sequence)`;
  }
  yield* sql`DELETE FROM conversation_memory_excluded_messages WHERE thread_id IN (
    SELECT thread_id FROM orchestration_v2_projection_threads WHERE deleted_at IS NOT NULL)`;
});
