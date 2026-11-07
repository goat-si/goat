import { isOrchestrationV2WorkActive } from "@goat/contracts";
import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
} from "@goat/contracts";
export function isTerminalProviderTurnStatus(
  status: OrchestrationV2ProviderTurn["status"],
): boolean {
  return (
    status === "completed" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "cancelled"
  );
}

export function isSettledRunEligibleForInheritedBackground(
  status: OrchestrationV2Run["status"],
): boolean {
  return status === "interrupted" || status === "failed" || status === "cancelled";
}

export function isSettledTurnItemStatus(status: OrchestrationV2TurnItem["status"]): boolean {
  return !isOrchestrationV2WorkActive(status);
}
