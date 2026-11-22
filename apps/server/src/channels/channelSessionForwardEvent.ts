import { ChannelTaskEvent, type ChannelTask, type MessageId, type ThreadId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import { answerForwardIdsFor, toolSteerIdsFor, turnSteerIdsFor } from "./channelIds.ts";

const decodeEvent = Schema.decodeUnknownEffect(Schema.fromJsonString(ChannelTaskEvent));
const forwardEventKey = (threadId: string, messageId: string) =>
  `channel-session-forward:${threadId}:${messageId}`;

export const sessionForwardDelivery = (
  sequence: number,
  event: Extract<ChannelTaskEvent, { type: "task.followup.received" | "task.question.answered" }>,
) => ({
  sequence,
  sender: event.payload.sender,
  inputId: event.actor === "user" ? event.payload.inputId : undefined,
});

export const recordSessionForwardEvent = (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  messageId: MessageId,
  sequence: number,
  now: string,
) =>
  sql`INSERT INTO channel_runtime_state (key, value_json, updated_at)
    VALUES (${forwardEventKey(threadId, messageId)}, json_quote(${sequence}), ${now})
    ON CONFLICT (key) DO NOTHING`;

const matches = (event: ChannelTaskEvent, generation: number, messageId: string) => {
  if (event.type === "task.question.answered")
    return answerForwardIdsFor(event.eventId).messageId === messageId ? event : undefined;
  if (event.type !== "task.followup.received" || event.payload.generation !== generation)
    return undefined;
  const { forwardKey, inputId } = event.payload;
  return (["first", "queued"] as const).some(
    (attempt) =>
      messageId ===
      (forwardKey === undefined
        ? turnSteerIdsFor(inputId, attempt)
        : toolSteerIdsFor(forwardKey, attempt)
      ).messageId,
  )
    ? event
    : undefined;
};

export const sessionForwardEventFor = Effect.fn("ChannelBotSession.forwardEventFor")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
  messageId: MessageId,
  task: Pick<ChannelTask, "taskId" | "generation" | "version">,
) {
  const [stored] = yield* sql<{ readonly event_json: string | null }>`
    SELECT event.event_json FROM channel_runtime_state AS link
    LEFT JOIN channel_task_events AS event
      ON event.sequence = json_extract(link.value_json, '$') AND event.task_id = ${task.taskId}
    WHERE link.key = ${forwardEventKey(threadId, messageId)}
  `;
  if (stored !== undefined) {
    return stored.event_json === null
      ? undefined
      : matches(yield* decodeEvent(stored.event_json), task.generation, messageId);
  }

  // Older queued intents can recover the sender from the event that supplied their message ID.
  let beforeVersion = task.version + 1;
  while (true) {
    const rows = yield* sql<{ readonly task_version: number; readonly event_json: string }>`
      SELECT task_version, event_json FROM channel_task_events
      WHERE task_id = ${task.taskId} AND task_version < ${beforeVersion}
        AND forward_state <> 'none'
        AND type IN ('task.followup.received', 'task.question.answered')
      ORDER BY task_version DESC LIMIT 32
    `;
    for (const row of rows) {
      const event = matches(yield* decodeEvent(row.event_json), task.generation, messageId);
      if (event !== undefined) return event;
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < 32) return undefined;
    beforeVersion = last.task_version;
  }
});
