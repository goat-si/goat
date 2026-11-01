import type { ComposerThreadDraftState } from "../composerDraftStore";

export function snapshotDraftContent(draft: ComposerThreadDraftState): string {
  return JSON.stringify({
    prompt: draft.prompt,
    images: draft.images.map(({ id }) => id),
    files: draft.files.map(({ id }) => id),
    nonPersistedImageIds: [...draft.nonPersistedImageIds],
    persistedAttachments: draft.persistedAttachments.map(({ id }) => id),
    terminalContexts: draft.terminalContexts,
    previewAnnotations: draft.previewAnnotations,
    reviewComments: draft.reviewComments,
    threadContexts: draft.threadContexts,
  });
}
export function isDraftContentUnchanged(
  snapshot: string,
  current: ComposerThreadDraftState | null | undefined,
): boolean {
  return current != null && snapshotDraftContent(current) === snapshot;
}
