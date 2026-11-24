import type { OrchestrationV2ProviderTurn } from "@goat/contracts";

export const isSyntheticClaudeTurnId = (nativeTurnId: string): boolean =>
  nativeTurnId.startsWith("turn:");

export const claudeTurnCursor = (turn: OrchestrationV2ProviderTurn): string | null => {
  const ref = turn.nativeTurnRef;
  return ref !== null &&
    ref.driver === "claudeAgent" &&
    ref.nativeId !== null &&
    !isSyntheticClaudeTurnId(ref.nativeId)
    ? ref.nativeId
    : null;
};

export const isTerminalProviderTurn = (turn: OrchestrationV2ProviderTurn): boolean =>
  turn.status === "completed" ||
  turn.status === "interrupted" ||
  turn.status === "failed" ||
  turn.status === "cancelled";
