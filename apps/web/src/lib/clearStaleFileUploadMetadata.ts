import type { EnvironmentId } from "@goat/contracts";
import type { ComposerThreadDraftState } from "../composerDraftStore";

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
