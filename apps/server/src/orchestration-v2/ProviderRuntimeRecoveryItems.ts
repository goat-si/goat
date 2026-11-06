import type { OrchestrationV2ThreadProjection } from "@goat/contracts";
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
