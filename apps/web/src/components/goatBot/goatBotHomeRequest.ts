import type { BotId, EnvironmentId } from "@goat/contracts";

export const goatBotHomeKey = (environmentId: EnvironmentId | null, botId: BotId | null) =>
  JSON.stringify([environmentId, botId]);

// A request from a navigation that never reached that bot's chat must not open Home later.
const HOME_REQUEST_TTL_MS = 10_000;
let homeRequest: { readonly key: string; readonly at: number } | null = null;

export function requestHomeOpen(key: string) {
  homeRequest = { key, at: Date.now() };
}

/** True once for a fresh request to open this bot's Home. */
export function takeHomeOpen(key: string): boolean {
  if (homeRequest?.key !== key) return false;
  const fresh = Date.now() - homeRequest.at <= HOME_REQUEST_TTL_MS;
  homeRequest = null;
  return fresh;
}
