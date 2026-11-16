import { DEFAULT_CLIENT_SETTINGS, type ClientSettings } from "@goat/contracts/settings";
import * as Equal from "effect/Equal";
import * as Struct from "effect/Struct";

import { foldLegacyFirstRunPrompt } from "~/components/desktop/firstRunPrompts.logic";
import { runWithStorageLock } from "~/lib/storageLock";
import { ensureLocalApi } from "~/localApi";

const CLIENT_SETTINGS_LOCK_KEY = "goat:client-settings:v1";

/**
 * Under a lock shared by every tab, writes the keys this tab edited over what the store holds now,
 * so a key another tab saved since this tab last read or wrote survives. Resolves with the next
 * baseline: the settings this tab wrote, or `baseline` unchanged when `persist` writes elsewhere.
 */
export function persistOverOtherTabs(input: {
  readonly settings: ClientSettings;
  readonly editedKeys: ReadonlySet<string>;
  /** This tab's settings as of its last write or read; keys still equal to it were not edited here. */
  readonly baseline: ClientSettings | null;
  readonly persist: (settings: ClientSettings) => Promise<void>;
  /** Only the default store can be read back; a caller's own persist writes elsewhere. */
  readonly readsBack: boolean;
}): Promise<ClientSettings | null> {
  const { settings, editedKeys, baseline, persist } = input;
  if (!input.readsBack) return persist(settings).then(() => baseline);
  return runWithStorageLock(CLIENT_SETTINGS_LOCK_KEY, async () => {
    const stored = baseline ? await ensureLocalApi().persistence.getClientSettings() : null;
    let merged = settings;
    if (stored && baseline) {
      // Folded as hydration folds it, so an answer under a legacy key is not copied back raw.
      const saved = foldLegacyFirstRunPrompt({ ...DEFAULT_CLIENT_SETTINGS, ...stored });
      const untouchedKeys = Struct.keys(settings).filter(
        (key) => !editedKeys.has(key) && Equal.equals(settings[key], baseline[key]),
      );
      merged = {
        ...settings,
        ...Object.fromEntries(untouchedKeys.map((key) => [key, saved[key]])),
      };
    }
    await persist(merged);
    return settings;
  });
}
