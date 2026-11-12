import type { BotProfile, EnvironmentId } from "@goat/contracts";
import { useSyncExternalStore } from "react";

// The profile a member rename from this client returned, which a member chat shows in place of
// the listed one until the bot list has been read since the rename (useRememberRenamedBot says
// when). The newest 50; an environment's go when it leaves the app.
const MAX_KEPT = 50;

interface Kept {
  readonly bot: BotProfile;
  stop: () => void;
}

let kept: ReadonlyArray<Kept> = [];
let renamed: ReadonlyArray<BotProfile> = [];
const listeners = new Set<() => void>();

function set(next: ReadonlyArray<Kept>) {
  kept = next;
  renamed = next.map((entry) => entry.bot);
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Keeps a renamed bot's profile until `watch` calls the retire it is given. `watch` returns how
 * to stop watching, which runs on retirement, on a later rename of the bot, and on forgetting.
 */
export function keepRenamedBot(bot: BotProfile, watch: (retire: () => void) => () => void): void {
  const entry: Kept = { bot, stop: () => {} };
  const retire = () => {
    entry.stop();
    if (kept.includes(entry)) set(kept.filter((other) => other !== entry));
  };
  entry.stop = watch(retire);
  const next = [
    ...kept.filter((other) => {
      const same = other.bot.environmentId === bot.environmentId && other.bot.botId === bot.botId;
      if (same) other.stop();
      return !same;
    }),
    entry,
  ];
  for (const dropped of next.slice(0, -MAX_KEPT)) dropped.stop();
  set(next.slice(-MAX_KEPT));
}

export function forgetRenamedBots(environmentId: EnvironmentId): void {
  const leaving = kept.filter((entry) => entry.bot.environmentId === environmentId);
  if (leaving.length === 0) return;
  for (const entry of leaving) entry.stop();
  set(kept.filter((entry) => entry.bot.environmentId !== environmentId));
}

export function useRenamedBots(): ReadonlyArray<BotProfile> {
  return useSyncExternalStore(subscribe, () => renamed);
}
