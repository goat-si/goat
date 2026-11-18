import type { OrchestrationV2ProviderTurn } from "@goat/contracts";

/** Boundaries are exclusive: use the next user message, or omit at head to retain the selected turn. */
export function openCodeBoundaryAfterProviderTurn(
  providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>,
  selectedProviderTurnId: OrchestrationV2ProviderTurn["id"],
): string | undefined {
  const selected = providerTurns.find((turn) => turn.id === selectedProviderTurnId);
  if (selected === undefined) return undefined;
  return providerTurns
    .filter((turn) => turn.ordinal > selected.ordinal)
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .map((turn) => turn.nativeTurnRef?.nativeId)
    .find((nativeId): nativeId is string => nativeId !== null && nativeId !== undefined);
}
