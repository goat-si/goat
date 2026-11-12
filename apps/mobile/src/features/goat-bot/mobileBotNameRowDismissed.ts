import {
  nameRowDismissalKey,
  withNewestDismissal,
  type BotNameRowDismissals,
} from "@goat/client-runtime/goatBot";
import type { EnvironmentId } from "@goat/contracts";
import * as SecureStore from "expo-secure-store";
import { useSyncExternalStore } from "react";

import { whenProtectedDataAvailable } from "../../lib/protectedData";

// Bots whose name row the person dismissed on this device, newest last and at most 200. A
// dismissal hides the row at once; if storing it fails, nothing says so and the row comes back
// after a restart. One write runs at a time and always stores the latest list.
const storageKey = "goat.bot-name-row-dismissed.v1";

let dismissed: ReadonlyArray<string> | null = null;
let loading: Promise<void> | null = null;
let writing = false;
let unwritten = false;
const listeners = new Set<() => void>();

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
    dismissed = withNewestDismissal(stored, dismissed ?? []);
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

function isDismissed(environmentId: EnvironmentId, botId: string): boolean | null {
  return dismissed === null ? null : dismissed.includes(nameRowDismissalKey(environmentId, botId));
}

/** Whether the row is dismissed for this bot; null until this device's list has been read. */
export function useBotNameRowDismissed(
  environmentId: EnvironmentId | null,
  botId: string | null,
): boolean | null {
  return useSyncExternalStore(subscribe, () =>
    environmentId === null || botId === null
      ? dismissed === null
        ? null
        : false
      : isDismissed(environmentId, botId),
  );
}

export function dismissBotNameRow(environmentId: EnvironmentId, botId: string): void {
  dismissed = withNewestDismissal(dismissed ?? [], [nameRowDismissalKey(environmentId, botId)]);
  emit();
  persist();
}

export const mobileBotNameRowDismissals = {
  dismissed: isDismissed,
  dismiss: dismissBotNameRow,
  subscribe,
} satisfies BotNameRowDismissals;
