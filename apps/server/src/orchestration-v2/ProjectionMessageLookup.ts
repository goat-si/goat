import type {
  MessageId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type * as SqlClient from "effect/sql/SqlClient";

export interface ProjectionMessageLookup<E> {
  readonly getMessagesById: (
    threadId: ThreadId,
    ids: ReadonlyArray<MessageId>,
  ) => Effect.Effect<ReadonlyMap<MessageId, OrchestrationV2ConversationMessage>, E>;
}
const encodeIds = Schema.encodeSync(Schema.fromJsonString(Schema.Array(Schema.String)));
export function makeMessageLookup<E, DecodeError>(
  sql: SqlClient.SqlClient,
  decode: (json: string) => Effect.Effect<OrchestrationV2ConversationMessage, DecodeError>,
  error: (threadId: ThreadId) => (cause: unknown) => E,
): ProjectionMessageLookup<E>["getMessagesById"] {
  return Effect.fn("ProjectionStore.getMessagesById")(
    function* (threadId, ids) {
      if (ids.length === 0) return new Map<MessageId, OrchestrationV2ConversationMessage>();
      const rows = yield* sql<{ payload_json: string }>`SELECT message.payload_json
      FROM json_each(${encodeIds([...new Set(ids)])}) AS requested
      CROSS JOIN orchestration_v2_projection_messages AS message ON message.message_id = requested.value
      WHERE message.thread_id = ${threadId}`;
      const messages = yield* Effect.forEach(rows, (row) => decode(row.payload_json));
      return new Map(messages.map((message) => [message.id, message]));
    },
    (effect, threadId) => effect.pipe(Effect.mapError(error(threadId))),
  );
}

function messageIdForTurnItem(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "user_message":
    case "assistant_message":
      return item.messageId;
    default:
      return null;
  }
}

export function sortMessagesByTurnItemOrder(
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
  turnItems: ReadonlyArray<OrchestrationV2TurnItem>,
  messageOrdinals = new Map<string, number>(),
): Array<OrchestrationV2ConversationMessage> {
  for (const turnItem of turnItems) {
    const messageId = messageIdForTurnItem(turnItem);
    if (messageId === null) {
      continue;
    }
    const existing = messageOrdinals.get(messageId);
    if (existing === undefined || turnItem.ordinal < existing) {
      messageOrdinals.set(messageId, turnItem.ordinal);
    }
  }

  return messages.toSorted((left, right) => {
    const leftOrdinal = messageOrdinals.get(left.id) ?? Number.MAX_SAFE_INTEGER;
    const rightOrdinal = messageOrdinals.get(right.id) ?? Number.MAX_SAFE_INTEGER;
    if (leftOrdinal !== rightOrdinal) {
      return leftOrdinal - rightOrdinal;
    }

    const leftCreatedAt = DateTime.toEpochMillis(left.createdAt);
    const rightCreatedAt = DateTime.toEpochMillis(right.createdAt);
    if (leftCreatedAt !== rightCreatedAt) {
      return leftCreatedAt - rightCreatedAt;
    }

    return left.id.localeCompare(right.id);
  });
}

export function automaticMessageIds(messages: Iterable<OrchestrationV2ConversationMessage>) {
  return new Set(
    [...messages]
      .filter(
        (message) =>
          message.role === "user" &&
          (message.notification !== undefined || message.delegatedCompletion !== undefined),
      )
      .map((message) => message.id),
  );
}
