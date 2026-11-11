import type { EnvironmentId } from "@goat/contracts";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

import { whenProtectedDataAvailable } from "../../lib/protectedData";

// Bots whose name row the person dismissed on this device, newest last and at most 200. A
// dismissal hides the row at once; if storing it fails, nothing says so and the row comes back
// after a restart. One write runs at a time and always stores the latest list.
const storageKey = "goat.bot-name-row-dismissed.v1";
const MAX_KEPT = 200;

let dismissed: ReadonlyArray<string> | null = null;
let loading: Promise<void> | null = null;
let writing = false;
let unwritten = false;
const listeners = new Set<() => void>();
const keyOf = (environmentId: EnvironmentId, botId: string) =>
  JSON.stringify([environmentId, botId]);

function emit() {
  for (const listener of listeners) listener();
}

/** Adds keys as the newest, once each, and keeps the newest 200. */
function withNewest(list: ReadonlyArray<string>, keys: ReadonlyArray<string>) {
  const added = new Set(keys);
  return [...list.filter((key) => !added.has(key)), ...keys].slice(-MAX_KEPT);
}

function load() {
  loading ??= (async () => {
    let stored: ReadonlyArray<string> = [];
    try {
      await whenProtectedDataAvailable();
      const raw = await SecureStore.getItemAsync(storageKey);
      const value: unknown = raw === null ? [] : JSON.parse(raw);
      if (Array.isArray(value))
        stored = value.filter((key): key is string => typeof key === "string");
    } catch {
      // Unreadable storage reads as nothing dismissed.
    }
    dismissed = withNewest(stored, dismissed ?? []);
    emit();
  })();
}

function persist() {
  unwritten = true;
  if (writing) return;
  writing = true;
  void (async () => {
    while (unwritten) {
      unwritten = false;
      try {
        await whenProtectedDataAvailable();
        await SecureStore.setItemAsync(storageKey, JSON.stringify(dismissed ?? []));
      } catch {
        // Hidden for this session; stated in the PR as a limit.
      }
    }
    writing = false;
  })();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  load();
  return () => listeners.delete(listener);
}

/** Whether the row is dismissed for this bot; null until this device's list has been read. */
export function useBotNameRowDismissed(
  environmentId: EnvironmentId | null,
  botId: string | null,
): boolean | null {
  return useSyncExternalStore(subscribe, () =>
    dismissed === null
      ? null
      : environmentId === null || botId === null
        ? false
        : dismissed.includes(keyOf(environmentId, botId)),
  );
}

export function dismissBotNameRow(environmentId: EnvironmentId, botId: string): void {
  dismissed = withNewest(dismissed ?? [], [keyOf(environmentId, botId)]);
  emit();
  persist();
}
