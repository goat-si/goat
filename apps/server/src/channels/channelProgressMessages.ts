import type { ChannelTask } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

/**
 * Channels whose messages GOAT cannot edit or take back. A person there hears one message before
 * the answer: the acknowledgement, or the first progress report when no acknowledgement reached
 * them. Later progress goes only to the bot's own chat, whose progress line reads it.
 */
const ONE_MESSAGE_BEFORE_ANSWER = new Set(["slack", "imessage"]);

/** Whether a progress report would be a second message before the answer on this channel. */
export const progressAlreadyTold = (sql: SqlClient.SqlClient, task: ChannelTask) =>
  ONE_MESSAGE_BEFORE_ANSWER.has(task.originAddress.kind)
    ? sql<{ readonly told: number }>`
        SELECT 1 AS told FROM channel_outbox
        WHERE destination_kind = ${task.originAddress.kind} AND kind = 'receipt'
          AND state <> 'failed'
          AND (task_id = ${task.taskId} OR input_id = ${task.originInputId})
        LIMIT 1`.pipe(
        Effect.map((rows) => rows.length > 0),
        Effect.orElseSucceed(() => false),
      )
    : Effect.succeed(false);
