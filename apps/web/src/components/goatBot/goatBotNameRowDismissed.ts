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
// write reads the stored list as it writes, so dismissals in one tab never drop each other. A
// dismissal storage refuses stays in memory, under the same cap, and goes with the next write
// until one takes it.
const STORAGE_KEY = "goat:bot-name-row-dismissed:v1";
const Dismissed = Schema.Array(Schema.String);
const NONE: ReadonlyArray<string> = [];
let refused: ReadonlyArray<string> = NONE;
const listeners = new Set<() => void>();

const readStored = () => readLocalStorageValue(STORAGE_KEY, NONE, Dismissed);

export const webBotNameRowDismissals = {
  dismissed: (environmentId, botId) => {
    const key = nameRowDismissalKey(environmentId, botId);
    return refused.includes(key) || readStored().includes(key);
  },
  dismiss: (environmentId, botId) => {
    const pending = withNewestDismissal(refused, [nameRowDismissalKey(environmentId, botId)]);
    writeLocalStorageValue(
      STORAGE_KEY,
      (list) => withNewestDismissal(list, pending),
      NONE,
      Dismissed,
    );
    // The write reports nothing; what storage now holds says which keys it took.
    const stored = new Set(readStored());
    refused = pending.filter((key) => !stored.has(key));
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

export function resetBotNameRowDismissalsForTests(): void {
  refused = NONE;
}
