import { create } from "zustand";
import type { ThreadId } from "@goat/contracts";

interface SideChatStore {
  /** Questions from `/side <question>`, keyed by the parent thread's scoped key. */
  readonly pendingPrompts: Readonly<Record<string, string>>;
  readonly selectedSideChats: Readonly<Record<string, ThreadId>>;
  readonly selectSideChat: (threadKey: string, threadId: ThreadId) => void;
  readonly setPendingPrompt: (threadKey: string, prompt: string) => void;
  readonly takePendingPrompt: (threadKey: string) => string | null;
}

/** A side question waiting for its side chat tab to be ready. The side chat itself is server state. */
export const useSideChatStore = create<SideChatStore>((set, get) => ({
  pendingPrompts: {},
  selectedSideChats: {},
  selectSideChat: (threadKey, threadId) =>
    set((state) => {
      const entries = Object.entries(state.selectedSideChats).filter(([key]) => key !== threadKey);
      return {
        selectedSideChats: Object.fromEntries([...entries.slice(-127), [threadKey, threadId]]),
      };
    }),
  setPendingPrompt: (threadKey, prompt) =>
    set((state) => ({ pendingPrompts: { ...state.pendingPrompts, [threadKey]: prompt } })),
  takePendingPrompt: (threadKey) => {
    const prompt = get().pendingPrompts[threadKey] ?? null;
    if (prompt !== null) {
      set((state) => {
        const { [threadKey]: _taken, ...pendingPrompts } = state.pendingPrompts;
        return { pendingPrompts };
      });
    }
    return prompt;
  },
}));
