import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

/**
 * A bot's task history pages tasks by creation and each task's launches by creation; none of
 * these change once written. The launch index holds only launches with a thread, and its
 * expressions and terms must match the history queries', which name it with INDEXED BY.
 * The inbox index holds only main messages, so a history row's count stops at its tenth.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_tasks_owner_bot_created
    ON channel_tasks(owner_id, bot_id, created_at, task_id)`;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_child_work_launches ON channel_runtime_state(
      json_extract(value_json, '$.taskId'), json_extract(value_json, '$.createdAt'), key)
    WHERE key >= 'child-work:' AND key < 'child-work;'
      AND json_extract(value_json, '$.surface') IN ('thread_launch', 'ssh_thread_launch')
      AND json_extract(value_json, '$.destination.threadId') IS NOT NULL
      AND (json_extract(value_json, '$.surface') = 'ssh_thread_launch'
        OR json_extract(value_json, '$.state') IN ('bound', 'completed', 'failed', 'cancelled'))`;
  yield* sql`CREATE INDEX IF NOT EXISTS channel_inbox_main_messages
    ON channel_inbox(owner_id, conversation_id, accepted_at)
    WHERE state != 'rejected' AND json_extract(message_json, '$.intent') = 'message'
      AND json_extract(message_json, '$.taskId') IS NULL
      AND json_extract(message_json, '$.actor.senderThreadId') IS NULL`;
});
