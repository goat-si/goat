import type { EnvironmentId } from "@goat/contracts";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

import { whenProtectedDataAvailable } from "../../lib/protectedData";

// Bots whose name row the person dismissed on this device. A dismissal hides the row at once; if
// storing it fails, nothing says so and the row comes back after a restart.
const storageKey = "goat.bot-name-row-dismissed.v1";

let dismissed: ReadonlySet<string> | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();
const keyOf = (environmentId: EnvironmentId, botId: string) =>
  JSON.stringify([environmentId, botId]);

function emit() {
  for (const listener of listeners) listener();
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
    dismissed = new Set([...stored, ...(dismissed ?? [])]);
    emit();
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
        : dismissed.has(keyOf(environmentId, botId)),
  );
}

export function dismissBotNameRow(environmentId: EnvironmentId, botId: string): void {
  dismissed = new Set([...(dismissed ?? []), keyOf(environmentId, botId)]);
  emit();
  const next = JSON.stringify([...dismissed]);
  void (async () => {
    try {
      await whenProtectedDataAvailable();
      await SecureStore.setItemAsync(storageKey, next);
    } catch {
      // Hidden for this session; stated in the PR as a limit.
    }
  })();
}
