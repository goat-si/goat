import { Debouncer } from "@tanstack/react-pacer";
import * as Equal from "effect/Equal";
import type { PersistStorage, StorageValue } from "zustand/middleware";

import type {
  ComposerDraftStoreState,
  PersistedComposerDraftStoreState,
} from "./composerDraftStore";
import { createMemoryStorage, resolveStorage } from "./lib/storage";
import { runWithStorageLock } from "./lib/storageLock";

const COMPOSER_PERSIST_DEBOUNCE_MS = 300;

export type ComposerPersistState =
  | { capturedState: ComposerDraftStoreState }
  | PersistedComposerDraftStoreState;

type ComposerPersistValue = StorageValue<ComposerPersistState>;

interface ComposerDraftWrite {
  readonly text: string;
  /** This tab's own state as of the write; entries it still matches were not edited here. */
  readonly local: PersistedComposerDraftStoreState;
  readonly merged: PersistedComposerDraftStoreState;
}

function mergeDraftRecord<V>(
  stored: Readonly<Record<string, V>> | undefined,
  local: Readonly<Record<string, V>>,
  baseline: Readonly<Record<string, V>>,
): Record<string, V> {
  const merged = { ...stored };
  for (const key of new Set([...Object.keys(local), ...Object.keys(baseline)])) {
    if (Equal.equals(local[key], baseline[key])) continue;
    const value = local[key];
    if (value === undefined) delete merged[key];
    else merged[key] = value;
  }
  return merged;
}

/** Writes only what this tab changed since its last write over what other tabs saved since. */
function mergeComposerDraftStates(
  stored: PersistedComposerDraftStoreState,
  local: PersistedComposerDraftStoreState,
  baseline: PersistedComposerDraftStoreState,
): PersistedComposerDraftStoreState {
  const pick = <K extends keyof PersistedComposerDraftStoreState>(key: K) => {
    const value = Equal.equals(local[key], baseline[key]) ? stored[key] : local[key];
    return value === undefined ? {} : { [key]: value };
  };
  return {
    draftsByThreadKey: mergeDraftRecord(
      stored.draftsByThreadKey,
      local.draftsByThreadKey,
      baseline.draftsByThreadKey,
    ),
    draftThreadsByThreadKey: mergeDraftRecord(
      stored.draftThreadsByThreadKey,
      local.draftThreadsByThreadKey,
      baseline.draftThreadsByThreadKey,
    ),
    logicalProjectDraftThreadKeyByLogicalProjectKey: mergeDraftRecord(
      stored.logicalProjectDraftThreadKeyByLogicalProjectKey,
      local.logicalProjectDraftThreadKeyByLogicalProjectKey,
      baseline.logicalProjectDraftThreadKeyByLogicalProjectKey,
    ),
    ...pick("stickyModelSelectionByProvider"),
    ...pick("stickyOptionsByModelByProvider"),
    ...pick("stickyActiveProvider"),
  };
}

export function createComposerPersistStorage(
  partializeComposerDraftStoreState: (
    state: ComposerDraftStoreState,
  ) => PersistedComposerDraftStoreState,
): {
  storage: PersistStorage<ComposerPersistState>;
  flush: () => void;
  /** Records the hydrated state, the baseline the first write merges against. */
  markLoaded: (state: ComposerDraftStoreState) => void;
} {
  const baseStorage = resolveStorage(
    typeof localStorage !== "undefined" ? localStorage : createMemoryStorage(),
  );
  let loadedState: PersistedComposerDraftStoreState | null = null;
  let lastWrite: ComposerDraftWrite | null = null;
  // Numbered so a write that waited for the lock never lands over a newer one.
  let requestedWrite = 0;
  let landedWrite = 0;
  let waitingWrite: { name: string; value: ComposerPersistValue; seq: number } | null = null;
  let writeSynchronously = false;

  const readStored = (name: string, version: number | undefined) => {
    const text = baseStorage.getItem(name);
    if (typeof text !== "string") return null;
    if (text === lastWrite?.text) return lastWrite.merged;
    try {
      const parsed = JSON.parse(text) as StorageValue<PersistedComposerDraftStoreState>;
      return parsed.version === version ? parsed.state : null;
    } catch {
      return null;
    }
  };

  const write = (name: string, value: ComposerPersistValue, seq: number) => {
    if (seq <= landedWrite) return;
    if (!("capturedState" in value.state)) {
      baseStorage.setItem(name, JSON.stringify({ state: value.state, version: value.version }));
    } else {
      const local = partializeComposerDraftStoreState(value.state.capturedState);
      const baseline = lastWrite?.local ?? loadedState;
      const stored = baseline ? readStored(name, value.version) : null;
      const merged = stored && baseline ? mergeComposerDraftStates(stored, local, baseline) : local;
      const text = JSON.stringify({ state: merged, version: value.version });
      baseStorage.setItem(name, text);
      lastWrite = { text, local, merged };
    }
    landedWrite = seq;
    if (waitingWrite && waitingWrite.seq <= seq) waitingWrite = null;
  };

  const debouncedWrite = new Debouncer(
    (name: string, value: ComposerPersistValue) => {
      const seq = ++requestedWrite;
      if (writeSynchronously) {
        write(name, value, seq);
        return;
      }
      waitingWrite = { name, value, seq };
      void runWithStorageLock(name, () => write(name, value, seq)).catch((error: unknown) => {
        console.error("[COMPOSER-DRAFTS] Could not persist drafts (storage quota?).", error);
      });
    },
    { wait: COMPOSER_PERSIST_DEBOUNCE_MS },
  );

  // The page may be gone before a lock is granted, so the last write lands without it.
  const flush = () => {
    writeSynchronously = true;
    try {
      debouncedWrite.flush();
      if (waitingWrite) write(waitingWrite.name, waitingWrite.value, waitingWrite.seq);
    } finally {
      writeSynchronously = false;
    }
  };

  const composerPersistStorage: PersistStorage<ComposerPersistState> = {
    getItem: (name) => {
      const raw = baseStorage.getItem(name);
      if (typeof raw !== "string") {
        return null;
      }
      return JSON.parse(raw) as ComposerPersistValue;
    },
    setItem: (name, value) => {
      debouncedWrite.maybeExecute(name, value);
    },
    removeItem: (name) => {
      debouncedWrite.cancel();
      // cancel() leaves the captured value in Pacer's lastArgs.
      debouncedWrite.reset();
      landedWrite = requestedWrite;
      waitingWrite = null;
      loadedState = null;
      lastWrite = null;
      baseStorage.removeItem(name);
    },
  };

  if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
    window.addEventListener("beforeunload", flush);
    window.addEventListener("pagehide", flush);
  }

  return {
    storage: composerPersistStorage,
    flush,
    markLoaded: (state) => {
      loadedState = partializeComposerDraftStoreState(state);
    },
  };
}
