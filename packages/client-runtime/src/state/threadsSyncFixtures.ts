import {
  EventId,
  MessageId,
  NodeId,
  RuntimeRequestId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadStreamItem,
  type OrchestrationV2TurnItem,
} from "@goat/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type * as RpcSession from "../rpc/session.ts";
import type { EnvironmentThreadState } from "./threadState.ts";

import { v2Now, v2Projection, v2ThreadId } from "./orchestrationV2TestFixtures.ts";

const THREAD_ID = v2ThreadId;

export function testSession(
  client: WsRpcProtocolClient,
  config?: { readonly completionMarker?: boolean },
): RpcSession.RpcSession {
  return {
    client,
    initialConfig: Effect.succeed(
      config?.completionMarker === true
        ? ({ threadResumeCompletionMarker: true } as never)
        : ({} as never),
    ),
    subscribeServerConfig: (input) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
}

export function awaitThreadState(
  observed: Queue.Queue<EnvironmentThreadState>,
  predicate: (state: EnvironmentThreadState) => boolean,
) {
  return Queue.take(observed).pipe(
    Effect.repeat({
      until: predicate,
    }),
  );
}

const REPLY_AT = DateTime.makeUnsafe("2026-06-20T01:30:00.000Z");
const replyItem = (text: string, textOmitted?: true): OrchestrationV2TurnItem => ({
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
  startedAt: REPLY_AT,
  completedAt: null,
  updatedAt: REPLY_AT,
  type: "assistant_message",
  messageId: MessageId.make("message-reply"),
  text,
  ...(textOmitted ? { textOmitted } : {}),
  streaming: true,
});

/** A streamed reply item; `textOmitted` sends it empty, deduplicated against its message body. */
export const assistantReply = (
  text: string,
  sequence: number,
  textOmitted?: true,
): OrchestrationV2ThreadStreamItem => ({
  kind: "event",
  sequence,
  event: {
    id: EventId.make(`event-reply-${sequence}`),
    type: "turn-item.updated",
    threadId: THREAD_ID,
    occurredAt: REPLY_AT,
    payload: replyItem(text, textOmitted),
  },
});

export const assistantMessage = (
  text: string,
  sequence: number,
): OrchestrationV2ThreadStreamItem => ({
  kind: "event",
  sequence,
  event: {
    id: EventId.make(`event-message-${sequence}`),
    type: "message.updated",
    threadId: THREAD_ID,
    occurredAt: REPLY_AT,
    payload: {
      id: MessageId.make("message-reply"),
      threadId: THREAD_ID,
      runId: null,
      nodeId: null,
      role: "assistant",
      text,
      attachments: [],
      streaming: true,
      createdAt: REPLY_AT,
      updatedAt: REPLY_AT,
    } as never,
  },
});

/** A projection whose newest visible row is a reply of this text. */
export const projectionWithReply = (
  projection: OrchestrationV2ThreadProjection,
  text: string,
): OrchestrationV2ThreadProjection => ({
  ...projection,
  visibleTurnItems: [
    ...projection.visibleTurnItems,
    {
      position: projection.visibleTurnItems.length,
      visibility: "local",
      sourceThreadId: THREAD_ID,
      sourceItemId: TurnItemId.make("item-reply"),
      item: replyItem(text),
    },
  ],
});

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
