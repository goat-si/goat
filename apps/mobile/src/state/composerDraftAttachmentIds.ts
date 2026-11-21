import type { DraftComposerAttachment } from "../lib/composerImages";

export function sameDraftAttachmentIds(
  left: ReadonlyArray<DraftComposerAttachment>,
  right: ReadonlyArray<DraftComposerAttachment>,
): boolean {
  return (
    left.length === right.length &&
    left.every((attachment, index) => attachment.id === right[index]?.id)
  );
}
