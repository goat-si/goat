import type { EnvironmentId } from "@goat/contracts";
import {
  useComposerDraftStore,
  type ComposerFileAttachment,
  type ComposerImageAttachment,
  type ComposerThreadTarget,
} from "../../composerDraftStore";
import { releaseDraftAttachments } from "../../lib/attachmentUploadQueue";

type Attachment = ComposerImageAttachment | ComposerFileAttachment;
const released = new WeakSet<Attachment>();
const releasedFileIds = new WeakMap<File, Set<string>>();

function markReleased(item: Attachment): boolean {
  if (released.has(item)) return false;
  if (item.file !== null) {
    const ids = releasedFileIds.get(item.file) ?? new Set<string>();
    if (ids.has(item.id)) return false;
    ids.add(item.id);
    releasedFileIds.set(item.file, ids);
  }
  released.add(item);
  return true;
}

export function releaseUnownedQueuedEditAttachments(
  attachments: ReadonlyArray<Attachment>,
  environmentId?: EnvironmentId,
): void {
  const drafts = Object.values(useComposerDraftStore.getState().draftsByThreadKey);
  const ownedIds = new Set(
    drafts.flatMap((draft) => [...draft.images, ...draft.files].map((item) => item.id)),
  );
  const ownedUrls = new Set(
    drafts.flatMap((draft) => draft.images.map((image) => image.previewUrl)),
  );
  const unowned = attachments.filter((item) => {
    return !ownedIds.has(item.id) && markReleased(item);
  });
  releaseDraftAttachments(unowned, environmentId);
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

export function discardQueuedEditDraft(
  target: ComposerThreadTarget,
  environmentId?: EnvironmentId,
): void {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(target);
  store.clearComposerContent(target);
  if (draft) releaseUnownedQueuedEditAttachments([...draft.images, ...draft.files], environmentId);
}
