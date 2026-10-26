import type { EnvironmentId } from "@goat/contracts";
import type { ComposerThreadDraftState } from "~/composerDraftStore";

export function clearStaleFileUploadMetadata(
  draft: ComposerThreadDraftState,
  environmentId: EnvironmentId,
): ComposerThreadDraftState {
  let changed = false;
  const files = draft.files.map((file) => {
    if (
      (file.uploadedAttachmentId === undefined && file.uploadEnvironmentId === undefined) ||
      file.uploadEnvironmentId === environmentId
    ) {
      return file;
    }

    changed = true;
    const nextFile = { ...file };
    delete nextFile.uploadedAttachmentId;
    delete nextFile.uploadEnvironmentId;
    return nextFile;
  });

  return changed ? { ...draft, files } : draft;
}

export function composerDraftHasUserContent(
  draft: ComposerThreadDraftState | null | undefined,
): boolean {
  if (!draft) {
    return false;
  }
  return (
    draft.prompt.trim().length > 0 ||
    draft.images.length > 0 ||
    draft.files.length > 0 ||
    draft.persistedAttachments.length > 0 ||
    draft.terminalContexts.length > 0 ||
    draft.previewAnnotations.length > 0 ||
    draft.reviewComments.length > 0 ||
    draft.threadContexts.length > 0 ||
    draft.previewTabs.length > 0
  );
}

export function shouldRemoveDraft(draft: ComposerThreadDraftState): boolean {
  return (
    draft.prompt.length === 0 &&
    draft.images.length === 0 &&
    draft.files.length === 0 &&
    draft.persistedAttachments.length === 0 &&
    draft.terminalContexts.length === 0 &&
    draft.previewAnnotations.length === 0 &&
    draft.reviewComments.length === 0 &&
    draft.threadContexts.length === 0 &&
    draft.previewTabs.length === 0 &&
    Object.keys(draft.modelSelectionByProvider).length === 0 &&
    draft.activeProvider === null &&
    draft.runtimeMode === null &&
    draft.interactionMode === null
  );
}
