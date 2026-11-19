import {
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import { releaseDraftAttachments } from "../../lib/attachmentUploadQueue";

type Attachment = ComposerImageAttachment | ComposerFileAttachment;

export function releaseUnownedQueuedEditAttachments(attachments: ReadonlyArray<Attachment>): void {
  const drafts = Object.values(useComposerDraftStore.getState().draftsByThreadKey);
  const ownedIds = new Set(
    drafts.flatMap((draft) => [...draft.images, ...draft.files].map((item) => item.id)),
  );
  const ownedUrls = new Set(
    drafts.flatMap((draft) => draft.images.map((image) => image.previewUrl)),
  );
  const unowned = attachments.filter((item) => !ownedIds.has(item.id));
  releaseDraftAttachments(unowned);
  for (const item of unowned) {
    if (
      item.type === "image" &&
      item.previewUrl.startsWith("blob:") &&
      !ownedUrls.has(item.previewUrl)
    ) {
      URL.revokeObjectURL(item.previewUrl);
    }
  }
}

export function discardQueuedEditDraft(target: ComposerThreadTarget): void {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(target);
  store.clearComposerContent(target);
  if (draft) releaseUnownedQueuedEditAttachments([...draft.images, ...draft.files]);
}
