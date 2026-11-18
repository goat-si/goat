import type { OrchestrationV2Subagent } from "@goat/contracts";

export function acpSubagentStatusIsTerminal(status: OrchestrationV2Subagent["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "cancelled" ||
    status === "idle"
  );
}

export function acpSubagentStatusBlocksTurnSettlement(
  status: OrchestrationV2Subagent["status"],
): boolean {
  return status === "running" || status === "pending";
}
