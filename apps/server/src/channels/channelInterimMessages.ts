import type { ChannelOutboundMessage } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * Channels whose messages GOAT cannot take back. A person there hears one message before the
 * answer: the acknowledgement, or else the first message written as interim (progress, placement,
 * a move). Everything else always goes; the bot's own chat keeps every step.
 */
const ONE_MESSAGE_BEFORE_ANSWER = new Set(["slack", "imessage"]);

export interface ClaimedOutboxRow {
  readonly delivery_id: string;
  readonly cause_key: string;
  readonly input_id: string | null;
  readonly task_id: string | null;
  readonly kind: string;
  readonly destination_kind: string;
}

/** A task's interim message, including narration written before the interim marker existed. */
export const isInterimMessage = Effect.fn("channelInterimMessages.isInterim")(function* (
  sql: SqlClient.SqlClient,
  row: ClaimedOutboxRow,
  message: ChannelOutboundMessage,
) {
  if (
    row.kind !== "receipt" ||
    message.kind !== "receipt" ||
    row.task_id === null ||
    !ONE_MESSAGE_BEFORE_ANSWER.has(row.destination_kind) ||
    row.cause_key === "reply:" + row.input_id
  )
    return false;
  if (message.interim === true) return true;
  const events = yield* sql<{
    readonly found: number;
  }>`SELECT 1 AS found FROM channel_task_events event
    WHERE event.task_id = ${row.task_id}
      AND event.event_id = substr(${row.cause_key}, 11, length(${row.cause_key}) - 17)
      AND ${row.cause_key} = 'narration:' || event.event_id || ':origin'
      AND event.type IN ('task.progress', 'task.dispatch.claimed', 'task.moved') LIMIT 1`;
  return events.length > 0;
});

/**
 * Whether the person already heard (or may have heard) a message before this one: the input's
 * acknowledgement or an earlier interim message of the task. Decided when the row is claimed, after
 * the delivery order has let the acknowledgement settle, so a late acknowledgement still counts
 * and one that failed does not.
 */
export const interimAlreadyHeard = Effect.fn("channelInterimMessages.alreadyHeard")(function* (
  sql: SqlClient.SqlClient,
  row: ClaimedOutboxRow,
) {
  const acknowledged = yield* sql<{ readonly heard: number }>`
    SELECT 1 AS heard FROM channel_outbox told
    WHERE told.cause_key = 'reply:' || COALESCE(${row.input_id},
        (SELECT json_extract(t.task_json, '$.originInputId') FROM channel_tasks t
          WHERE t.task_id = ${row.task_id}))
      AND told.state IN ('delivered', 'ambiguous')
    LIMIT 1`;
  if (acknowledged.length > 0) return true;
  const earlier = yield* sql<{ readonly heard: number }>`
    SELECT 1 AS heard FROM channel_outbox told
    WHERE told.task_id = ${row.task_id} AND told.destination_kind = ${row.destination_kind}
      AND told.kind = 'receipt' AND told.state IN ('delivered', 'ambiguous')
      AND (json_extract(told.message_json, '$.interim') = 1 OR EXISTS (
        SELECT 1 FROM channel_task_events event
        WHERE event.task_id = told.task_id
          AND event.event_id = substr(told.cause_key, 11, length(told.cause_key) - 17)
          AND told.cause_key = 'narration:' || event.event_id || ':origin'
          AND event.type IN ('task.progress', 'task.dispatch.claimed', 'task.moved')
      ))
      AND told.delivery_id != ${row.delivery_id}
    LIMIT 1`;
  return earlier.length > 0;
});
