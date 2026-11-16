import type { PersistStorage, StorageValue } from "zustand/middleware";

import type {
  ComposerDraftStoreState,
  PersistedComposerDraftStoreState,
} from "./composerDraftStore";
import { createDeferredStorage, createMemoryStorage } from "./lib/storage";

const COMPOSER_PERSIST_DEBOUNCE_MS = 300;

export type ComposerPersistState =
  | { capturedState: ComposerDraftStoreState }
  | PersistedComposerDraftStoreState;

export function createComposerPersistStorage(
  partializeComposerDraftStoreState: (
    state: ComposerDraftStoreState,
  ) => PersistedComposerDraftStoreState,
): { storage: PersistStorage<ComposerPersistState>; flush: () => void } {
  const composerDebouncedStorage = createDeferredStorage<StorageValue<ComposerPersistState>>(
    typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
    (value) =>
      JSON.stringify({
        state:
          "capturedState" in value.state
            ? partializeComposerDraftStoreState(value.state.capturedState)
            : value.state,
        version: value.version,
      }),
    COMPOSER_PERSIST_DEBOUNCE_MS,
  );

  const composerPersistStorage: PersistStorage<ComposerPersistState> = {
    getItem: (name) => {
      const raw = composerDebouncedStorage.getItem(name);
      if (typeof raw !== "string") {
        return null;
      }
      return JSON.parse(raw) as StorageValue<ComposerPersistState>;
    },
    setItem: (name, value) => composerDebouncedStorage.setItem(name, value),
    removeItem: (name) => composerDebouncedStorage.removeItem(name),
  };

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("beforeunload", () => {
      composerDebouncedStorage.flush();
    });
  }

  return { storage: composerPersistStorage, flush: () => composerDebouncedStorage.flush() };
}
