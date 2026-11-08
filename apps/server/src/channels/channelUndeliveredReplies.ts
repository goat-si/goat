/**
 * Savepoint copy of a failed or ambiguous Slack or iMessage reply into the bot's GOAT chat.
 *
 * @module channelUndeliveredReplies
 */
import { BotId, ChannelInputId, ChannelOutboundMessage } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

import { botLedger } from "./channelBotLedger.ts";
import { replyDelivery } from "./channelReplyDelivery.ts";

const READABLE_KINDS = new Set(["result", "question", "failure", "receipt"]);
const decodeOutbound = Schema.decodeUnknownSync(Schema.fromJsonString(ChannelOutboundMessage));
const encodeOutbound = Schema.encodeSync(Schema.fromJsonString(ChannelOutboundMessage));
const decodeInputId = Schema.decodeUnknownSync(ChannelInputId);

export interface UndeliveredSourceRow {
  readonly delivery_id: string;
  readonly input_id: string | null;
  readonly task_id: string | null;
  readonly kind: string;
  readonly destination_kind: string;
  readonly message_json: string;
}

const present = (value: string | null | undefined) =>
  value === undefined || value === null || value.length === 0 ? undefined : value;

const placeName = (kind: string) => (kind === "imessage" ? "iMessage" : "Slack");

const copyText = (outcome: "failed" | "ambiguous", place: string, text: string) => {
  const lead =
    outcome === "failed"
      ? `This reply didn't reach ${place}:`
      : `This reply may not have reached ${place} (GOAT stopped while sending it):`;
  return `${lead}\n\n${text}`;
};

const writeCopy = Effect.fn("channelUndeliveredReplies.write")(function* (
  sql: SqlClient.SqlClient,
  row: UndeliveredSourceRow,
  outcome: "failed" | "ambiguous",
  now: string,
) {
  const message = decodeOutbound(row.message_json);
  if (message.text.trim() === "") return;
  const inputId = present(row.input_id);
  const taskId = present(row.task_id);
  let ownerId: string | undefined;
  let botId: string | undefined;
  let originInputId: string | undefined;
  if (inputId !== undefined) {
    const found = (yield* sql<{ readonly owner_id: string; readonly bot_id: string }>`
          SELECT owner_id, bot_id FROM channel_inbox WHERE input_id = ${inputId}
        `)[0];
    if (found !== undefined) {
      ownerId = found.owner_id;
      botId = found.bot_id;
    }
  }
  if ((ownerId === undefined || botId === undefined) && taskId !== undefined) {
    const found = (yield* sql<{
      readonly owner_id: string;
      readonly bot_id: string;
      readonly origin_input_id: string | null;
    }>`
          SELECT owner_id, bot_id,
            json_extract(task_json, '$.originInputId') AS origin_input_id
          FROM channel_tasks WHERE task_id = ${taskId}
        `)[0];
    if (found !== undefined) {
      ownerId = found.owner_id;
      botId = found.bot_id;
      originInputId = present(found.origin_input_id);
    }
  }
  const replyTo =
    message.inReplyToInputId ??
    (inputId !== undefined
      ? decodeInputId(inputId)
      : originInputId !== undefined
        ? decodeInputId(originInputId)
        : undefined);
  const bot =
    ownerId === undefined || botId === undefined
      ? undefined
      : yield* botLedger(sql).getBotById(ownerId, BotId.make(botId));
  if (bot === undefined || replyTo === undefined) {
    yield* Effect.logWarning("undelivered reply has no GOAT Bot chat to copy into", {
      deliveryId: row.delivery_id,
    });
    return;
  }
  const built = replyDelivery({
    causeKey: "undelivered:" + row.delivery_id,
    destination: {
      kind: "goat",
      environmentId: bot.bot.environmentId,
      threadId: bot.bot.threadId,
    },
    kind: "failure",
    text: copyText(outcome, placeName(row.destination_kind), message.text),
    replyTo,
  });
  yield* sql`
      INSERT INTO channel_outbox (
        delivery_id, cause_key, input_id, task_id, kind, destination_kind, message_json,
        state, attempts, next_attempt_at, created_at, updated_at
      ) VALUES (
        ${built.deliveryId}, ${built.causeKey}, ${null},
        ${null}, ${built.message.kind}, ${built.message.destination.kind},
        ${encodeOutbound(built.message)},
        'pending', 0, ${now}, ${now}, ${now}
      )
      ON CONFLICT DO NOTHING
    `;
});

/** A failure here rolls back only this savepoint, never the outcome that was just recorded. */
export const copyUndeliveredReply = Effect.fn("channelUndeliveredReplies.copy")(function* (
  sql: SqlClient.SqlClient,
  row: UndeliveredSourceRow,
  outcome: "failed" | "ambiguous",
  now: string,
) {
  if (row.destination_kind !== "slack" && row.destination_kind !== "imessage") return;
  if (!READABLE_KINDS.has(row.kind)) return;
  yield* sql.withTransaction(writeCopy(sql, row, outcome, now)).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("undelivered reply was not copied to the GOAT Bot chat", {
        cause,
        deliveryId: row.delivery_id,
      }),
    ),
  );
});

export const copyUndeliveredReplies = Effect.fn("channelUndeliveredReplies.copyRows")(function* (
  sql: SqlClient.SqlClient,
  rows: ReadonlyArray<UndeliveredSourceRow>,
  outcome: "failed" | "ambiguous",
  now: string,
) {
  yield* Effect.forEach(rows, (row) => copyUndeliveredReply(sql, row, outcome, now), {
    discard: true,
  });
});
