import type { RunResult } from "@cursor/sdk";
import type { OrchestrationV2ProviderTurn } from "@goat/contracts";

// After a turn ends, a retryable error can resume an older checkpoint and report failure despite an answer.
const POST_TURN_RETRY_ERRORS = new Set([
  "Agent turn stopped after repeated resume attempts made no progress",
  "Connection failed repeatedly",
]);
type TurnState = { readonly interrupted: boolean; readonly turnEnded: boolean };

export const isResumeFailureAfterTurnEnded = (context: TurnState, result: RunResult) =>
  context.turnEnded &&
  result.status === "error" &&
  POST_TURN_RETRY_ERRORS.has(result.error?.message ?? "");

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
