import type { ChannelInputId, ChannelTask, MessageId, ThreadId } from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import { ChannelLedgerError } from "./channelLedgerError.ts";
import { isChannelWorkerThreadId, workerLaunchIdsFor } from "./channelIds.ts";

const keyFor = (threadId: ThreadId) => "channel-worker-context:" + threadId;
const followUpKeyFor = (threadId: ThreadId, messageId: MessageId) =>
  "channel-worker-followup-sender:" + threadId + ":" + messageId;

export const bindWorkerProviderBrief = Effect.fn("channel.bindWorkerProviderBrief")(function* (
  sql: SqlClient.SqlClient,
  task: ChannelTask,
  threadId: ThreadId,
) {
  yield* sql`
    INSERT INTO channel_runtime_state (key, value_json, updated_at)
    VALUES (${keyFor(threadId)}, json_object('taskId', ${task.taskId}, 'generation', ${task.generation}), ${task.updatedAt})
    ON CONFLICT (key) DO NOTHING
  `.pipe(
    Effect.mapError(
      (cause) =>
        new ChannelLedgerError({
          reason: "persistence",
          detail: "Could not bind the worker brief.",
          cause,
        }),
    ),
  );
});

export const workerContextOwner = Effect.fn("channel.workerContextOwner")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const [owner] = yield* sql<{
    readonly task_id: ChannelTask["taskId"];
    readonly generation: number;
  }>`
    SELECT json_extract(value_json, '$.taskId') AS task_id,
      json_extract(value_json, '$.generation') AS generation
    FROM channel_runtime_state WHERE key = ${keyFor(threadId)}
  `;
  return owner;
});

export const bindWorkerFollowUpSender = Effect.fn("channel.bindWorkerFollowUpSender")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  messageId: MessageId,
  inputId: ChannelInputId,
) {
  const now = DateTime.formatIso(yield* DateTime.now);
  yield* sql`
    INSERT INTO channel_runtime_state (key, value_json, updated_at)
    VALUES (${followUpKeyFor(threadId, messageId)}, json_quote(${inputId}), ${now})
    ON CONFLICT (key) DO NOTHING
  `.pipe(
    Effect.mapError(
      (cause) =>
        new ChannelLedgerError({
          reason: "persistence",
          detail: "Could not bind the worker follow-up sender.",
          cause,
        }),
    ),
  );
});

export const workerFollowUpSenderInput = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  messageId: MessageId,
) =>
  sql<{ readonly input_id: ChannelInputId }>`
    SELECT json_extract(value_json, '$') AS input_id
    FROM channel_runtime_state WHERE key = ${followUpKeyFor(threadId, messageId)}
  `.pipe(Effect.map((rows) => rows[0]?.input_id));

export const readChannelProviderBrief = Effect.fn("channel.readProviderBrief")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  messageId: MessageId,
) {
  const worker = isChannelWorkerThreadId(threadId);
  const owner = worker
    ? yield* workerContextOwner(sql, threadId)
    : (yield* sql<{ readonly task_id: ChannelTask["taskId"]; readonly generation: number }>`
        SELECT task_id, task_generation AS generation FROM channel_bot_session_runs
        WHERE thread_id = ${threadId} AND message_id = ${messageId} AND kind IN ('launch','task')
      `)[0];
  if (
    owner === undefined ||
    (worker && workerLaunchIdsFor(owner.task_id, owner.generation).messageId !== messageId)
  )
    return undefined;
  const [row] = yield* sql<{ readonly delivered_text: string }>`
    SELECT json_extract(event_json, '$.payload.brief.deliveredText') AS delivered_text
    FROM channel_task_events
    WHERE task_id = ${owner.task_id} AND type = 'task.brief.frozen'
      AND json_extract(event_json, '$.payload.brief.generation') = ${owner.generation}
    ORDER BY sequence DESC LIMIT 1
  `;
  return row?.delivered_text;
});

export const sessionCarriesNotes = Effect.fn("channel.sessionCarriesNotes")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const [row] = yield* sql<{ readonly carries_notes: number }>`
    SELECT EXISTS (
      SELECT 1 FROM channel_bot_session_runs r
      JOIN channel_task_events e ON e.task_id = r.task_id AND e.type = 'task.brief.frozen'
      WHERE r.thread_id = ${threadId}
        AND json_extract(e.event_json, '$.payload.brief.generation') = r.task_generation
        AND json_extract(e.event_json, '$.payload.brief.context.notesPath') IS NOT NULL
    ) AS carries_notes
  `;
  return row?.carries_notes === 1;
});
