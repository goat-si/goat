import type { ScopedProjectRef, ScopedThreadRef } from "@goat/contracts";
import { scopedThreadKey } from "@goat/client-runtime/environment";

import {
  type DraftId,
  resolveComposerDraftKey,
  useComposerDraftStore,
} from "../composerDraftStore";
import { releaseDraftAttachments } from "./attachmentUploadQueue";

export function releaseComposerDraftUploads(target: ScopedThreadRef | DraftId): void {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(target);
  const key = resolveComposerDraftKey(store, target);
  const environmentId =
    typeof target === "string"
      ? key === null
        ? undefined
        : store.draftThreadsByThreadKey[key]?.environmentId
      : target.environmentId;
  if (draft) {
    releaseDraftAttachments([...draft.images, ...draft.files], environmentId);
  }
}

export function releaseProjectDraftUploads(
  projectRef: ScopedProjectRef,
  projectThreadRefs: ReadonlyArray<ScopedThreadRef> = [],
): void {
  const store = useComposerDraftStore.getState();
  for (const [draftKey, session] of Object.entries(store.draftThreadsByThreadKey)) {
    if (
      session.environmentId === projectRef.environmentId &&
      session.projectId === projectRef.projectId
    ) {
      const draft = store.draftsByThreadKey[draftKey];
      releaseDraftAttachments(
        draft ? [...draft.images, ...draft.files] : [],
        projectRef.environmentId,
      );
    }
  }
  for (const threadRef of projectThreadRefs) {
    const draft = store.draftsByThreadKey[scopedThreadKey(threadRef)];
    if (draft) {
      releaseDraftAttachments([...draft.images, ...draft.files], threadRef.environmentId);
    }
  }
}
