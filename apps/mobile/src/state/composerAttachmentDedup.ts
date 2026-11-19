import type { DraftComposerAttachment } from "../lib/composerImages";

export function deduplicateComposerAttachments(
  existing: ReadonlyArray<DraftComposerAttachment>,
  incoming: ReadonlyArray<DraftComposerAttachment>,
): { attachments: DraftComposerAttachment[]; duplicates: DraftComposerAttachment[] } {
  const seen = [...existing];
  const attachments: DraftComposerAttachment[] = [];
  const duplicates: DraftComposerAttachment[] = [];
  for (const attachment of incoming) {
    const duplicate = seen.some(
      (item) =>
        (item.fileUri !== undefined &&
          item.fileUri !== "" &&
          item.fileUri === attachment.fileUri) ||
        (item.type === "image" &&
          attachment.type === "image" &&
          item.name === attachment.name &&
          item.mimeType === attachment.mimeType &&
          item.sizeBytes === attachment.sizeBytes &&
          item.dataUrl !== undefined &&
          item.dataUrl !== "" &&
          item.dataUrl === attachment.dataUrl) ||
        (item.uploadedAttachmentId !== undefined &&
          item.uploadEnvironmentId !== undefined &&
          item.uploadedAttachmentId === attachment.uploadedAttachmentId &&
          item.uploadEnvironmentId === attachment.uploadEnvironmentId),
    );
    if (duplicate) duplicates.push(attachment);
    else {
      seen.push(attachment);
      attachments.push(attachment);
    }
  }
  return { attachments, duplicates };
}
