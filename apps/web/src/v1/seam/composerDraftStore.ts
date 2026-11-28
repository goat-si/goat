// Seam for v1 apps/web/src/composerDraftStore.ts (goat 916b5ccc1b2), shared by lanes F and P2-M. v1's 4,000-line draft
// store is not carried: GOAT 2 keeps drafts in its own composer. DraftId keeps v1's schema (composerDraftStore.ts:138).
// The lifted TraitsPicker is always given onModelOptionsChange in GOAT 2, so it never writes options into a draft.
import type { EnvironmentId, ThreadId } from "@goat/contracts";
import * as Schema from "effect/Schema";

export const DraftId = Schema.String.pipe(Schema.brand("DraftId"));
export type DraftId = typeof DraftId.Type;

interface Goat2DraftStoreState {
  readonly setProviderModelOptions: (...args: ReadonlyArray<unknown>) => void;
  readonly getDraftSession: (
    draftId: DraftId,
  ) => { readonly environmentId: EnvironmentId; readonly threadId: ThreadId } | null;
}

const state: Goat2DraftStoreState = {
  setProviderModelOptions: () => {
    throw new Error("GOAT 2 has no v1 composer drafts; pass onModelOptionsChange to TraitsPicker.");
  },
  getDraftSession: () => null,
};

export function useComposerDraftStore<T>(selector: (store: Goat2DraftStoreState) => T): T {
  return selector(state);
}
