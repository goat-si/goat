import type {
  EventId,
  OrchestrationV2DomainEvent,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  TurnItemId,
} from "@goat/contracts";
import type * as DateTime from "effect/DateTime";

export const cancelledItem = (
  item: OrchestrationV2ThreadProjection["turnItems"][number],
  now: DateTime.Utc,
): OrchestrationV2ThreadProjection["turnItems"][number] =>
  item.type === "secret_request" && item.secretStatus === "pending"
    ? {
        ...item,
        status: "cancelled",
        secretStatus: "cancelled",
        completedAt: now,
        updatedAt: now,
        ...(item.handoff
          ? {
              handoff: {
                ...item.handoff,
                state: "cancelled" as const,
                resolvedAt: now,
                actor: { type: "server" as const },
              },
            }
          : {}),
      }
    : {
        ...item,
        ...("streaming" in item ? { streaming: false } : {}),
        status: "cancelled",
        completedAt: now,
        updatedAt: now,
      };

export function isBackgroundCapableTurnItemType(type: string): boolean {
  return type === "command_execution" || type === "dynamic_tool" || type === "subagent";
}

export function recoveryNotice(input: {
  readonly eventId: EventId;
  readonly itemId: TurnItemId;
  readonly run: OrchestrationV2Run;
  readonly now: DateTime.Utc;
  readonly trigger: "startup" | "shutdown";
  readonly detail: string;
}): OrchestrationV2DomainEvent {
  const { eventId, itemId, run, now, trigger, detail } = input;
  return {
    id: eventId,
    type: "turn-item.updated",
    threadId: run.threadId,
    runId: run.id,
    ...(run.rootNodeId === null ? {} : { nodeId: run.rootNodeId }),
    providerInstanceId: run.providerInstanceId,
    occurredAt: now,
    payload: {
      id: itemId,
      threadId: run.threadId,
      runId: run.id,
      nodeId: run.rootNodeId,
      providerThreadId: run.providerThreadId,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: trigger === "startup" ? "Server restarted" : "Server shut down",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      type: "system_notice",
      message: detail,
    },
  };
}
