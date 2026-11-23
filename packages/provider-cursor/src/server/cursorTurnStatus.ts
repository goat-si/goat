import type { RunResult } from "@cursor/sdk";
import type { OrchestrationV2ProviderTurn } from "@goat/contracts";

const RESUME_NO_PROGRESS = "Agent turn stopped after repeated resume attempts made no progress";
type TurnState = { readonly interrupted: boolean; readonly turnEnded: boolean };

export const isResumeFailureAfterTurnEnded = (context: TurnState, result: RunResult) =>
  context.turnEnded && result.status === "error" && result.error?.message === RESUME_NO_PROGRESS;

export const terminalStatus = (
  context: TurnState,
  result: RunResult,
): Extract<
  OrchestrationV2ProviderTurn["status"],
  "completed" | "interrupted" | "failed" | "cancelled"
> => {
  if (context.interrupted) return "interrupted";
  switch (result.status) {
    case "finished":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "error":
      return isResumeFailureAfterTurnEnded(context, result) ? "completed" : "failed";
  }
};
