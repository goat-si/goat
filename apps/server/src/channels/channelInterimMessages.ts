import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * Channels whose messages GOAT cannot edit or take back. A person there hears one message before
 * the answer: the acknowledgement, or the first interim message (progress, where the work runs)
 * when no acknowledgement reached them. Questions, failures and results always go. The bot's own
 * chat keeps every step, which its progress line reads.
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

/** A task's message before its answer, to a channel that keeps every message it was sent. */
export const isInterimMessage = (row: ClaimedOutboxRow) =>
  row.task_id !== null &&
  row.kind === "receipt" &&
  ONE_MESSAGE_BEFORE_ANSWER.has(row.destination_kind) &&
  row.cause_key !== "reply:" + row.input_id;

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
      AND told.delivery_id != ${row.delivery_id}
    LIMIT 1`;
  return earlier.length > 0;
});
