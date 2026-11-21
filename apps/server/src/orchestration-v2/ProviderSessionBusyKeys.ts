import type { ProviderThreadId } from "@goat/contracts";

export const busyTurnPrefix = (providerThreadId: ProviderThreadId) => `${providerThreadId}#`;
export const busyTurnKey = (providerThreadId: ProviderThreadId, runOrdinal: number) =>
  `${busyTurnPrefix(providerThreadId)}${runOrdinal}`;
