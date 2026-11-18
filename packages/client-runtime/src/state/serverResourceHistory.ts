import { WS_METHODS } from "@goat/contracts";

export const processResourceHistoryOptions = {
  label: "environment-data:server:process-resource-history",
  tag: WS_METHODS.serverGetProcessResourceHistory,
  staleTimeMs: 5_000,
  refreshIntervalMs: 5_000,
  idleTtlMs: 0,
} as const;
