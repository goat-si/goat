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
        item.mimeType === attachment.mimeType &&
        item.sizeBytes === attachment.sizeBytes &&
        item.name === attachment.name &&
        (item.type !== "image" ||
          attachment.type !== "image" ||
          item.dataUrl === attachment.dataUrl),
    );
    if (duplicate) duplicates.push(attachment);
    else {
      seen.push(attachment);
      attachments.push(attachment);
    }
  }
  return { attachments, duplicates };
}
