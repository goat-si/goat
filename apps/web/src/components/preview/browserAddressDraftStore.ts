import { create } from "zustand";

const MAX_ADDRESS_DRAFTS = 100;

/** Ephemeral edits survive tab/panel remounts, without becoming browsing history. */
export const useBrowserAddressDraftStore = create<{
  drafts: ReadonlyMap<string, string>;
  setDraft: (key: string, value: string | undefined) => void;
}>()((set) => ({
  drafts: new Map(),
  setDraft: (key, value) =>
    set((state) => {
      const drafts = new Map(state.drafts);
      drafts.delete(key);
      if (value !== undefined) drafts.set(key, value);
      if (drafts.size > MAX_ADDRESS_DRAFTS) drafts.delete(drafts.keys().next().value!);
      return { drafts };
    }),
}));
