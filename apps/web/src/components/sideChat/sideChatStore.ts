import { create } from "zustand";

interface SideChatPanelState {
  /** A question to send once the panel is ready, from `/side <question>`. */
  readonly pendingPrompt: string | null;
}

interface SideChatStore {
  /** Open panels, keyed by the parent thread's scoped key. */
  readonly panels: Readonly<Record<string, SideChatPanelState>>;
  readonly open: (threadKey: string, prompt?: string) => void;
  readonly close: (threadKey: string) => void;
  readonly toggle: (threadKey: string) => void;
  readonly takePendingPrompt: (threadKey: string) => string | null;
}

/** Which threads show their side chat. Kept in memory: the side chat itself is server state. */
export const useSideChatStore = create<SideChatStore>((set, get) => ({
  panels: {},
  open: (threadKey, prompt) =>
    set((state) => ({
      panels: {
        ...state.panels,
        [threadKey]: { pendingPrompt: prompt?.trim() ? prompt.trim() : null },
      },
    })),
  close: (threadKey) =>
    set((state) => {
      if (!(threadKey in state.panels)) return state;
      const { [threadKey]: _closed, ...panels } = state.panels;
      return { panels };
    }),
  toggle: (threadKey) => {
    if (threadKey in get().panels) get().close(threadKey);
    else get().open(threadKey);
  },
  takePendingPrompt: (threadKey) => {
    const prompt = get().panels[threadKey]?.pendingPrompt ?? null;
    if (prompt !== null) {
      set((state) => ({
        panels: { ...state.panels, [threadKey]: { pendingPrompt: null } },
      }));
    }
    return prompt;
  },
}));
