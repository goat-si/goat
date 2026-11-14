import type {
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  ProviderTurnId,
} from "@goat/contracts";

// /goal control turns never reach Codex and must not count toward native rollback.
export const isTerminalProviderTurn = (turn: OrchestrationV2ProviderTurn): boolean =>
  turn.nativeTurnRef !== null &&
  (turn.status === "completed" ||
    turn.status === "interrupted" ||
    turn.status === "failed" ||
    turn.status === "cancelled");

export const providerTurnsForThread = (
  providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  providerThread: OrchestrationV2ProviderThread,
): ReadonlyArray<OrchestrationV2ProviderTurn> =>
  providerTurns.filter((turn) => turn.providerThreadId === providerThread.id);

export const countTerminalTurnsAfterBoundary = (
  providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  providerTurnId: ProviderTurnId,
): number | null => {
  const boundaryTurn = providerTurns.find((turn) => turn.id === providerTurnId);
  if (boundaryTurn === undefined) {
    return null;
  }

  return providerTurns.filter(
    (turn) => turn.ordinal > boundaryTurn.ordinal && isTerminalProviderTurn(turn),
  ).length;
};
