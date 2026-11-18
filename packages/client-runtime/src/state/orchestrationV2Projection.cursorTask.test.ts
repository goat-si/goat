import {
  EventId,
  MessageId,
  ProviderDriverKind,
  TurnItemId,
  type OrchestrationV2DomainEvent,
} from "@goat/contracts";
import { expect, it } from "vite-plus/test";
import { applyOrchestrationV2ProjectionEvent } from "./orchestrationV2Projection.ts";
import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";

it("inserts a saved Cursor Task step within a loaded partial timeline", () => {
  const step = (ordinal: number, nativeId: string | null): OrchestrationV2DomainEvent => ({
    id: EventId.make(`event-${ordinal}`),
    type: "turn-item.updated",
    threadId: v2ThreadId,
    occurredAt: v2Now,
    payload: {
      id: TurnItemId.make(`item-${ordinal}`),
      threadId: v2ThreadId,
      runId: null,
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: { driver: ProviderDriverKind.make("cursor"), nativeId, strength: "weak" },
      parentItemId: null,
      ordinal,
      status: "completed",
      title: null,
      startedAt: v2Now,
      completedAt: v2Now,
      updatedAt: v2Now,
      type: "assistant_message",
      text: nativeId ?? "",
      messageId: MessageId.make(`message-${ordinal}`),
      streaming: false,
    },
  });
  const projection = applyOrchestrationV2ProjectionEvent(
    applyOrchestrationV2ProjectionEvent(v2Projection, step(613, "live-first")),
    step(1126, "live-later"),
  );
  const options = { partialTimeline: true, latestLocalTurnOrdinal: 1126 };
  const next = applyOrchestrationV2ProjectionEvent(
    projection,
    step(1125, "cursor-task-saved:fixture:1"),
    options,
  );
  expect(next?.visibleTurnItems.map((row) => row.item.id)).toEqual([
    "item-613",
    "item-1125",
    "item-1126",
  ]);
  expect(
    applyOrchestrationV2ProjectionEvent(next, step(612, "cursor-task-saved:fixture:0"), options),
  ).toBe(next);
  expect(applyOrchestrationV2ProjectionEvent(next, step(1124, null), options)).toBe(next);
});
