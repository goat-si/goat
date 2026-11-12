import {
  nameRowDismissalKey,
  withNewestDismissal,
  type BotNameRowDismissals,
} from "@goat/client-runtime/goatBot";
import * as Schema from "effect/Schema";

import {
  readLocalStorageValue,
  subscribeLocalStorageKey,
  writeLocalStorageValue,
} from "~/hooks/useLocalStorage";

// Bots whose name row the person dismissed in this browser, newest last and at most 200. Each
// write reads the stored list as it writes, so dismissals in one tab never drop each other. This
// session's dismissals are also kept in memory, so the row stays hidden when storage refuses one.
const STORAGE_KEY = "goat:bot-name-row-dismissed:v1";
const Dismissed = Schema.Array(Schema.String);
const NONE: ReadonlyArray<string> = [];
const hiddenThisSession = new Set<string>();
const listeners = new Set<() => void>();

export const webBotNameRowDismissals = {
  dismissed: (environmentId, botId) => {
    const key = nameRowDismissalKey(environmentId, botId);
    return (
      hiddenThisSession.has(key) ||
      readLocalStorageValue(STORAGE_KEY, NONE, Dismissed).includes(key)
    );
  },
  dismiss: (environmentId, botId) => {
    const key = nameRowDismissalKey(environmentId, botId);
    hiddenThisSession.add(key);
    writeLocalStorageValue(
      STORAGE_KEY,
      (list) => withNewestDismissal(list, [key]),
      NONE,
      Dismissed,
    );
    for (const listener of listeners) listener();
  },
  subscribe: (listener) => {
    listeners.add(listener);
    const stopStorage = subscribeLocalStorageKey(STORAGE_KEY, listener);
    return () => {
      listeners.delete(listener);
      stopStorage();
    };
  },
} satisfies BotNameRowDismissals;
