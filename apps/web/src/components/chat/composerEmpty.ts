import { composerDraftHasUserContent, useComposerDraftStore } from "../../composerDraftStore";

type ComposerTarget = Parameters<
  ReturnType<typeof useComposerDraftStore.getState>["getComposerDraft"]
>[0];

export function useComposerNonPromptContent(target: ComposerTarget) {
  return useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(target);
    return draft ? composerDraftHasUserContent({ ...draft, prompt: "" }) : false;
  });
}

export function isComposerEmpty(
  editing: boolean,
  pending: number,
  hasContent: boolean,
  prompt: string,
) {
  return !editing && pending === 0 && !hasContent && prompt.trim().length === 0;
}

export function useComposerHasAttachments(target: ComposerTarget) {
  return useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(target);
    return (draft?.images.length ?? 0) > 0 || (draft?.files.length ?? 0) > 0;
  });
}

export function useComposerHasSshAttachments(target: ComposerTarget) {
  return useComposerDraftStore((store) => {
    const draft = store.getComposerDraft(target);
    return (
      draft != null &&
      (draft.images.length > 0 ||
        draft.files.length > 0 ||
        draft.nonPersistedImageIds.length > 0 ||
        draft.persistedAttachments.length > 0)
    );
  });
}
