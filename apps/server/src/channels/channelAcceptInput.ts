import {
  ChannelInboundMessage,
  ChannelReplyAddress,
  ChannelRequester,
  MAIN_BOT_ID,
  type ChannelIngestResult,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";
import type * as SqlError from "effect/sql/SqlError";

import type { ChannelLedger, ChannelOutboxInsert, ChannelStoredInput } from "./ChannelLedger.ts";
import { ChannelLedgerError } from "./channelLedgerError.ts";
import { isActiveMember } from "./channelBotLedger.ts";
import { deliveryIdFor } from "./channelIds.ts";
import { insertOutboxRows } from "./channelProgressMessages.ts";
import { routeSlackInput } from "./slack/slackBotRouting.ts";

type AcceptInput = Parameters<ChannelLedger["Service"]["acceptInput"]>[0];

const encodeInbound = Schema.encodeSync(Schema.fromJsonString(ChannelInboundMessage));
const encodeRequester = Schema.encodeSync(Schema.fromJsonString(ChannelRequester));
const encodeAddress = Schema.encodeSync(Schema.fromJsonString(ChannelReplyAddress));

/** The receipt view of a stored input: no reply or read time. */
const toIngestResult = (stored: ChannelStoredInput, duplicate: boolean): ChannelIngestResult => {
  const { readAt: _readAt, reply: _reply, failure: _failure, ...result } = stored.snapshot;
  return { ...result, duplicate };
};

const privateNotice = (input: AcceptInput, text: string): ChannelOutboxInsert | undefined => {
  const userId = input.message.actor.externalActorId;
  if (userId === undefined) return undefined;
  const causeKey = "slack-route:" + input.inputId;
  const deliveryId = deliveryIdFor(causeKey);
  return {
    deliveryId,
    causeKey,
    inputId: input.inputId,
    message: {
      deliveryId,
      kind: "receipt",
      destination: input.message.replyAddress,
      inReplyToInputId: input.inputId,
      // A build that does not know private Slack notices must see an empty public body.
      text: "",
      slackPrivateNotice: { userId, text },
    },
  };
};

export const acceptChannelInput = Effect.fn("ChannelLedger.acceptInput")(function* (
  sql: SqlClient.SqlClient,
  readInbox: (inputId: string) => Effect.Effect<ChannelStoredInput | undefined, SqlError.SqlError>,
  input: AcceptInput,
) {
  const receiptFor = (id: string, duplicate: boolean) =>
    readInbox(id).pipe(
      Effect.flatMap((stored) =>
        stored === undefined
          ? Effect.fail(
              new ChannelLedgerError({
                reason: "persistence",
                detail: "Stored input could not be read back.",
              }),
            )
          : Effect.succeed(toIngestResult(stored, duplicate)),
      ),
    );
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      const existing = yield* sql<{ readonly input_id: string; readonly content_hash: string }>`
            SELECT input_id, content_hash FROM channel_inbox
            WHERE owner_id = ${input.ownerId} AND kind = ${input.message.kind}
              AND connection_id = ${input.message.connectionId}
              AND idempotency_key = ${input.message.idempotencyKey}
          `;
      const found = existing[0];
      if (found !== undefined) {
        if (found.content_hash !== input.contentHash) {
          return yield* new ChannelLedgerError({
            reason: "idempotency_conflict",
            detail: "Different content under a stored idempotency key.",
          });
        }
        return yield* receiptFor(found.input_id, true);
      }
      const slack = input.message.kind === "slack";
      const route =
        slack && input.requester !== undefined
          ? yield* routeSlackInput(sql, input, input.message.text)
          : undefined;
      const refused = route?.notice;
      const requester = refused === undefined ? input.requester : undefined;
      const botId = route?.botId ?? input.botId ?? MAIN_BOT_ID;
      const message =
        route?.text === undefined ? input.message : { ...input.message, text: route.text };
      const pinned = route?.botId ?? null;
      // The decisive check against a delete: both are write transactions, so one sees the other.
      if (!slack && botId !== MAIN_BOT_ID) {
        if (!(yield* isActiveMember(sql, input.ownerId, botId))) {
          return yield* new ChannelLedgerError({
            reason: "bot_inactive",
            detail: "The bot is not active.",
          });
        }
      }
      yield* sql`
            INSERT INTO channel_conversations (
              conversation_id, owner_id, kind, connection_id, conversation_key, last_activity_at, slack_bot_id
            ) VALUES (
              ${input.conversationId}, ${input.ownerId}, ${input.message.kind},
              ${input.message.connectionId}, ${input.message.conversationKey}, ${input.acceptedAt}, ${pinned}
            )
            ON CONFLICT (owner_id, kind, connection_id, conversation_key)
            DO UPDATE SET last_activity_at = excluded.last_activity_at,
              slack_bot_id = COALESCE(channel_conversations.slack_bot_id, excluded.slack_bot_id)
          `;
      yield* sql`
            INSERT INTO channel_bindings (
              binding_id, conversation_id, connection_id, reply_address_json, last_activity_at
            ) VALUES (
              ${input.bindingId}, ${input.conversationId}, ${input.message.connectionId},
              ${encodeAddress(input.message.replyAddress)}, ${input.acceptedAt}
            )
            ON CONFLICT (binding_id) DO UPDATE SET last_activity_at = excluded.last_activity_at
          `;
      yield* sql`
            INSERT INTO channel_inbox (
              input_id, owner_id, kind, connection_id, idempotency_key, content_hash,
              conversation_id, binding_id, message_json, requester_json, state, accepted_at, bot_id, auth_session_id
            ) VALUES (
              ${input.inputId}, ${input.ownerId}, ${input.message.kind},
              ${input.message.connectionId}, ${input.message.idempotencyKey}, ${input.contentHash},
              ${input.conversationId}, ${input.bindingId}, ${encodeInbound(message)},
              ${requester === undefined ? null : encodeRequester(requester)},
              ${requester === undefined ? "rejected" : "accepted"}, ${input.acceptedAt},
              ${botId}, ${input.authSessionId ?? null}
            )
          `;
      const notice = refused === undefined ? input.rejectNotice : privateNotice(input, refused);
      if (notice !== undefined) yield* insertOutboxRows(sql, [notice], input.acceptedAt);
      return yield* receiptFor(input.inputId, false);
    }),
  );
});
