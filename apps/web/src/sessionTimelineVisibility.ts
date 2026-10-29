import type { OrchestrationV2TurnItem } from "@goat/contracts";
import { turnItemIsWorkspacePreparation } from "@goat/client-runtime/state/turn-item-presentation";

export function hideTimelineItem(item: OrchestrationV2TurnItem): boolean {
  return (
    (turnItemIsWorkspacePreparation(item) && !item.deferredWork) ||
    item.type === "todo_list" ||
    item.type === "checkpoint" ||
    (item.type === "user_message" &&
      item.inputIntent === "queued_turn" &&
      item.status === "pending")
  );
}
