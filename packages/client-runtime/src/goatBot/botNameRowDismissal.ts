import type { EnvironmentId } from "@goat/contracts";

/** Where a client keeps the bots whose name row the person dismissed on this device. */
export interface BotNameRowDismissals {
  /** Whether the row is dismissed for this bot; null until this device's list has been read. */
  dismissed(environmentId: EnvironmentId, botId: string): boolean | null;
  dismiss(environmentId: EnvironmentId, botId: string): void;
  subscribe(listener: () => void): () => void;
}

const MAX_KEPT = 200;

// Stored lists hold these keys, so the format must not change.
export const nameRowDismissalKey = (environmentId: EnvironmentId, botId: string) =>
  JSON.stringify([environmentId, botId]);

/** Adds keys as the newest, once each, and keeps the newest 200. */
export function withNewestDismissal(list: ReadonlyArray<string>, keys: ReadonlyArray<string>) {
  const added = new Set(keys);
  return [...list.filter((key) => !added.has(key)), ...keys].slice(-MAX_KEPT);
}
