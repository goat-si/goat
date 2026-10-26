import type {
  OrchestrationV2DomainEvent,
  OrchestrationV2TurnItem,
  RunId,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
// Cloud finalization writes a message and its ordinary assistant item together.
// Check persisted items inside the ownership-gated transaction: exact provider
// text from this run is reused; other text and prior runs never suppress a result.
// Replayed synthetic results keep their original message, position and timing.
export const makeCloudResultItemGuard = <E>(
  read: (
    threadId: ThreadId,
    runId: RunId,
  ) => Effect.Effect<
    {
      readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
    },
    E
  >,
) =>
  Effect.fnUntraced(function* (events: ReadonlyArray<OrchestrationV2DomainEvent>) {
    const skippedItems = new Set<string>(),
      skippedMessages = new Set<string>();
    for (const event of events) {
      if (
        event.type !== "turn-item.updated" ||
        event.payload.type !== "assistant_message" ||
        event.payload.runId === null ||
        event.payload.id !== `turn-item:cloud-result:${event.payload.runId}`
      )
        continue;
      const item = event.payload;
      const { turnItems } = yield* read(item.threadId, event.payload.runId);
      if (turnItems.some((existing) => existing.id === item.id)) {
        skippedItems.add(item.id);
        skippedMessages.add(item.messageId);
      } else if (
        turnItems.some(
          (existing) => existing.type === "assistant_message" && existing.text === item.text,
        )
      ) {
        skippedItems.add(item.id);
      }
    }
    return events.filter((event) =>
      event.type === "turn-item.updated"
        ? !skippedItems.has(event.payload.id)
        : event.type !== "message.updated" || !skippedMessages.has(event.payload.id),
    );
  });
