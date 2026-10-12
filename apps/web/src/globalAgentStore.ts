import type { ChannelBotRef, EnvironmentId, ThreadId } from "@goat/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import type { DraftId } from "./composerDraftStore";
import { resolveStorage } from "./lib/storage";

export const GLOBAL_AGENT_STORAGE_KEY = "goat:global-agent:v1";
const GLOBAL_AGENT_STORAGE_VERSION = 2;

/**
 * The one projectless thread GOAT opens on launch and from the sidebar logo.
 * Client-local: each installation remembers its own global agent.
 */
export interface GlobalAgentRef {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly draftId: DraftId;
}

/**
 * Which agent the logo opens when the server offers GOAT Bot: the bot's messenger, or the
 * global agent's coding thread. Client-local, like the refs.
 */
export type GlobalAgentMode = "bot" | "thread";

export interface GlobalAgentStoreState {
  ref: GlobalAgentRef | null;
  /**
   * The server's GOAT Bot thread, as last confirmed. It marks which thread is the bot, so it
   * survives archive and delete; whether the bot can take messages is decided per connection.
   */
  botRef: ChannelBotRef | null;
  mode: GlobalAgentMode;
  setRef: (ref: GlobalAgentRef) => void;
  setBotRef: (botRef: ChannelBotRef) => void;
  setMode: (mode: GlobalAgentMode) => void;
  /** Forgets the global agent when the given thread is it (archived or deleted here). The bot ref stays. */
  clearIfThread: (target: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }) => void;
}

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.length > 0;

export function isGlobalAgentRef(value: unknown): value is GlobalAgentRef {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Record<string, unknown>;
  return (
    isNonEmptyString(ref.environmentId) &&
    isNonEmptyString(ref.threadId) &&
    isNonEmptyString(ref.draftId)
  );
}

function isChannelBotRef(value: unknown): value is ChannelBotRef {
  if (typeof value !== "object" || value === null) return false;
  const ref = value as Record<string, unknown>;
  return (
    isNonEmptyString(ref.environmentId) &&
    isNonEmptyString(ref.projectId) &&
    isNonEmptyString(ref.threadId)
  );
}

function readPersistedRef(persisted: unknown): GlobalAgentRef | null {
  const ref = (persisted as { ref?: unknown } | null | undefined)?.ref;
  return isGlobalAgentRef(ref) ? ref : null;
}

function readPersistedBotRef(persisted: unknown): ChannelBotRef | null {
  const botRef = (persisted as { botRef?: unknown } | null | undefined)?.botRef;
  return isChannelBotRef(botRef) ? botRef : null;
}

function readPersistedMode(persisted: unknown): GlobalAgentMode {
  const mode = (persisted as { mode?: unknown } | null | undefined)?.mode;
  return mode === "thread" ? "thread" : "bot";
}

/** Hydration from another storage version. Versions before GOAT Bot had no bot to keep. */
export function migratePersistedGlobalAgent(persisted: unknown): {
  ref: GlobalAgentRef | null;
  botRef: ChannelBotRef | null;
  mode: GlobalAgentMode;
} {
  return { ref: readPersistedRef(persisted), botRef: null, mode: "bot" };
}

/** Same-version hydration: zustand skips migrate here, so validate again. */
export function mergePersistedGlobalAgent(
  persisted: unknown,
  current: GlobalAgentStoreState,
): GlobalAgentStoreState {
  return {
    ...current,
    ref: readPersistedRef(persisted),
    botRef: readPersistedBotRef(persisted),
    mode: readPersistedMode(persisted),
  };
}

export const useGlobalAgentStore = create<GlobalAgentStoreState>()(
  persist(
    (set) => ({
      ref: null,
      botRef: null,
      mode: "bot",
      setRef: (ref) => set({ ref }),
      setBotRef: (botRef) => set({ botRef }),
      setMode: (mode) => set({ mode }),
      clearIfThread: (target) =>
        set((state) =>
          state.ref !== null &&
          state.ref.environmentId === target.environmentId &&
          state.ref.threadId === target.threadId
            ? { ref: null }
            : state,
        ),
    }),
    {
      name: GLOBAL_AGENT_STORAGE_KEY,
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      version: GLOBAL_AGENT_STORAGE_VERSION,
      migrate: (persisted) => migratePersistedGlobalAgent(persisted) as GlobalAgentStoreState,
      merge: (persisted, current) => mergePersistedGlobalAgent(persisted, current),
      partialize: ({ ref, botRef, mode }) => ({ ref, botRef, mode }),
    },
  ),
);
