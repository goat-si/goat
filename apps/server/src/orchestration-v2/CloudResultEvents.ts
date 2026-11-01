import {
  MessageId,
  TurnItemId,
  type EventId,
  type NodeId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type ProviderThreadId,
  type ProviderTurnId,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";

import { redactGoatCredentials } from "../mcp/goatCredentialRedaction.ts";

/** Commit the pair with terminal state in the caller's ownership-gated write.
 * EventSink deduplicates the stable item and assigns its durable ordinal there.
 */
export const makeCloudResultEvents = <E>(input: {
  readonly run: OrchestrationV2Run;
  readonly nodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId | null;
  readonly text: string;
  readonly completedAt: DateTime.Utc;
  readonly allocateEventId: () => Effect.Effect<EventId, E>;
}) =>
  Effect.gen(function* () {
    // EventSink deduplicates this text against stored items, which the event store redacted.
    const text = redactGoatCredentials(input.text);
    const messageId = MessageId.make(`message:cloud-result:${input.run.id}`);
    const identity = {
      threadId: input.run.threadId,
      runId: input.run.id,
      nodeId: input.nodeId,
    };
    const eventIdentity = {
      ...identity,
      providerInstanceId: input.run.providerInstanceId,
      occurredAt: input.completedAt,
    };
    return [
      {
        ...eventIdentity,
        id: yield* input.allocateEventId(),
        type: "message.updated",
        payload: {
          ...identity,
          id: messageId,
          createdBy: "agent",
          creationSource: "provider",
          role: "assistant",
          text,
          attachments: [],
          streaming: false,
          createdAt: input.completedAt,
          updatedAt: input.completedAt,
        },
      },
      {
        ...eventIdentity,
        id: yield* input.allocateEventId(),
        type: "turn-item.updated",
        payload: {
          ...identity,
          id: TurnItemId.make(`turn-item:cloud-result:${input.run.id}`),
          type: "assistant_message",
          providerThreadId: input.providerThreadId,
          providerTurnId: input.providerTurnId,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          status: "completed",
          title: null,
          startedAt: input.completedAt,
          completedAt: input.completedAt,
          updatedAt: input.completedAt,
          messageId,
          text,
          attachments: [],
          streaming: false,
        },
      },
    ] satisfies OrchestrationV2DomainEvent[];
  });
