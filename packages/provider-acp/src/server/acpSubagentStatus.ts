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

export function acpSubagentHasPendingBackgroundWork(subagent: {
  readonly task: Pick<OrchestrationV2Subagent, "status">;
  readonly terminalStatusProjected: boolean;
}): boolean {
  return (
    acpSubagentStatusBlocksTurnSettlement(subagent.task.status) || !subagent.terminalStatusProjected
  );
}
