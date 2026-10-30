import {
  EventId,
  MessageId,
  NodeId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";

import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";

const THREAD_ID = v2ThreadId;

export const assistantReply = (text: string, sequence: number): OrchestrationV2ThreadStreamItem => {
  const at = DateTime.makeUnsafe("2026-06-20T01:30:00.000Z");
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make(`event-reply-${sequence}`),
      type: "turn-item.updated",
      threadId: THREAD_ID,
      occurredAt: at,
      payload: {
        id: TurnItemId.make("item-reply"),
        threadId: THREAD_ID,
        runId: null,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 40,
        status: "running",
        title: null,
        startedAt: at,
        completedAt: null,
        updatedAt: at,
        type: "assistant_message",
        messageId: MessageId.make("message-reply"),
        text,
        streaming: true,
      },
    },
  };
};

export const snapshot = (
  projection: OrchestrationV2ThreadProjection,
  snapshotSequence = 1,
): Extract<OrchestrationV2ThreadStreamItem, { readonly kind: "snapshot" }> => ({
  kind: "snapshot",
  snapshotSequence,
  projection,
});

export const synchronized = (): OrchestrationV2ThreadStreamItem => ({ kind: "synchronized" });

export const PENDING_QUESTION = {
  id: RuntimeRequestId.make("question"),
  nodeId: NodeId.make("question-node"),
  providerTurnId: null,
  nativeRequestRef: null,
  kind: "user_input" as const,
  status: "pending" as const,
  responseCapability: { type: "message" as const },
  createdAt: v2Now,
  resolvedAt: null,
};

export const questionResolved = (sequence: number): OrchestrationV2ThreadStreamItem => ({
  kind: "event",
  sequence,
  event: {
    id: EventId.make("event-request"),
    type: "runtime-request.updated",
    threadId: THREAD_ID,
    occurredAt: v2Now,
    payload: { ...PENDING_QUESTION, status: "resolved", resolvedAt: v2Now },
  },
});

export const titleUpdated = (title: string, sequence = 2): OrchestrationV2ThreadStreamItem => {
  const occurredAt = DateTime.makeUnsafe("2026-06-20T01:00:00.000Z");
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make("event-title"),
      type: "thread.metadata-updated",
      threadId: THREAD_ID,
      occurredAt,
      payload: { ...v2Projection.thread, title, updatedAt: occurredAt },
    },
  };
};

export const deleted = (sequence = 3): OrchestrationV2ThreadStreamItem => {
  const occurredAt = DateTime.makeUnsafe("2026-06-20T02:00:00.000Z");
  return {
    kind: "event",
    sequence,
    event: {
      id: EventId.make("event-deleted"),
      type: "thread.deleted",
      threadId: THREAD_ID,
      occurredAt,
      payload: { ...v2Projection.thread, updatedAt: occurredAt, deletedAt: occurredAt },
    },
  };
};
