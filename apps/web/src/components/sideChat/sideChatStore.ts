import { create } from "zustand";

interface SideChatStore {
  /** Questions from `/side <question>`, keyed by the parent thread's scoped key. */
  readonly pendingPrompts: Readonly<Record<string, string>>;
  readonly setPendingPrompt: (threadKey: string, prompt: string) => void;
  readonly takePendingPrompt: (threadKey: string) => string | null;
}

/** A side question waiting for its side chat tab to be ready. The side chat itself is server state. */
export const useSideChatStore = create<SideChatStore>((set, get) => ({
  pendingPrompts: {},
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
