import type { OrchestrationV2Subagent, OrchestratorMcpDelegateTaskResult } from "@goat/contracts";

type TerminalTaskStatus = Extract<
  OrchestratorMcpDelegateTaskResult["status"],
  "completed" | "failed" | "cancelled" | "interrupted"
>;

export function isTerminalTaskStatus(
  status: OrchestratorMcpDelegateTaskResult["status"] | OrchestrationV2Subagent["status"],
): status is TerminalTaskStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

// pendingRequestIds lists questions on the task's own runs; hasPendingQuestion covers any live one.
const hasTaskQuestion = (
  result: Pick<OrchestratorMcpDelegateTaskResult, "hasPendingQuestion" | "pendingRequestIds">,
) => result.hasPendingQuestion || (result.pendingRequestIds?.length ?? 0) > 0;

export function endsTaskWait(result: OrchestratorMcpDelegateTaskResult): boolean {
  return (
    hasTaskQuestion(result) ||
    result.pendingApproval !== null ||
    isTerminalTaskStatus(result.status)
  );
}
