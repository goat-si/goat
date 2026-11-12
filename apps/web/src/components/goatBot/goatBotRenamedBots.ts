import type { BotProfile, EnvironmentId } from "@goat/contracts";
import { useSyncExternalStore } from "react";

// The profile a rename from this client returned. A member chat shows it until a list read at
// least as new holds the bot, so a re-read that failed after the rename never shows the old name.
// The newest 50; an environment's go when it leaves the app.
const MAX_KEPT = 50;
const NONE: ReadonlyArray<BotProfile> = [];
let renamed = NONE;
const listeners = new Set<() => void>();

function set(next: ReadonlyArray<BotProfile>) {
  renamed = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function rememberRenamedBot(bot: BotProfile): void {
  const others = renamed.filter(
    (kept) => kept.environmentId !== bot.environmentId || kept.botId !== bot.botId,
  );
  set([...others, bot].slice(-MAX_KEPT));
}

export function forgetRenamedBots(environmentId: EnvironmentId): void {
  if (renamed.some((bot) => bot.environmentId === environmentId))
    set(renamed.filter((bot) => bot.environmentId !== environmentId));
}

export function useRenamedBots(): ReadonlyArray<BotProfile> {
  return useSyncExternalStore(subscribe, () => renamed);
}

/** The newer of two profiles of one bot; the listed one wins a tie. */
export function newerBotProfile(
  listed: BotProfile | null,
  kept: BotProfile | null,
): BotProfile | null {
  if (listed === null || kept === null) return listed ?? kept;
  return Date.parse(kept.updatedAt) > Date.parse(listed.updatedAt) ? kept : listed;
}
