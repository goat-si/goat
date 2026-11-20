import { scopedThreadKey, scopeThreadRef } from "@goat/client-runtime/environment";
import {
  onThreadRequestsResolved,
  pruneResolvedUserInputDrafts,
  resolvedQuestionDraftKeys,
  userInputDraftKey,
} from "@goat/client-runtime/state/thread-requests";
import { questionDraftKeysForRequests } from "@goat/client-runtime/state/unsent-question-answers";
import type {
  EnvironmentId,
  RuntimeRequestId,
  ScopedThreadRef,
  ThreadContextRecord,
  ThreadId,
} from "@goat/contracts";
import { create } from "zustand";
import { usePendingUserInputAnswers } from "./pendingUserInputAnswers";
import {
  type ComposerThreadDraftState,
  DraftId,
  useComposerDraftStore,
} from "./composerDraftStore";
import { releaseDraftAttachments } from "./lib/attachmentUploadQueue";
import {
  countQuestionAttachments,
  questionAttachmentDraftId,
  questionAttachmentDraftPrefix,
  useQuestionAttachmentPreparation,
} from "./questionAttachmentDrafts";
import {
  carryDisplacedCustomAnswerIntoPrompt,
  threadContextsReferencedByAnswer,
} from "./pendingUserInput";

/** Edited question answers, keyed by `userInputDraftKey`; suggested answers are not stored. */
export { usePendingUserInputAnswers };
// Light enough for the Decisions inbox, which must not load the attachment upload queue.
export {
  countQuestionAttachments,
  questionAttachmentDraftId,
  questionAttachmentDraftPrefix,
  useQuestionAttachmentPreparation,
};
export const usePendingUserInputQuestionIndex = create<Record<string, number>>(() => ({}));

type OpenQuestionAttachmentDraft = {
  readonly draftId: DraftId;
  readonly requestKeys: ReadonlyArray<DraftId>;
};

const openQuestionDrafts = new Map<string, OpenQuestionAttachmentDraft>();

export function openQuestionAttachmentDraft(
  threadRef: ScopedThreadRef,
): OpenQuestionAttachmentDraft | null {
  return openQuestionDrafts.get(scopedThreadKey(threadRef)) ?? null;
}

export function countQuestionRequestAttachments(draftId: DraftId): number | null {
  for (const draft of openQuestionDrafts.values()) {
    if (draft.draftId === draftId) return countQuestionAttachments(draft.requestKeys);
  }
  return null;
}

export function trackOpenQuestionAttachmentDraft(
  threadRef: ScopedThreadRef,
  draft: OpenQuestionAttachmentDraft,
): () => void {
  const key = scopedThreadKey(threadRef);
  openQuestionDrafts.set(key, draft);
  return () => {
    if (openQuestionDrafts.get(key) === draft) openQuestionDrafts.delete(key);
  };
}

export function changeQuestionAttachmentPreparation(key: DraftId, delta: number): void {
  useQuestionAttachmentPreparation.setState((state) =>
    delta < 0 && !(key in state.counts)
      ? state
      : {
          counts: { ...state.counts, [key]: Math.max(0, (state.counts[key] ?? 0) + delta) },
        },
  );
}

export function clearQuestionAttachmentDraft(
  key: DraftId,
  retained?: Pick<ComposerThreadDraftState, "images" | "files"> | null,
  environmentId?: EnvironmentId,
): void {
  const store = useComposerDraftStore.getState();
  const draft = store.getComposerDraft(key);
  if (draft) {
    const retainedAttachments = [...(retained?.images ?? []), ...(retained?.files ?? [])];
    const abandoned = [...draft.images, ...draft.files].filter(
      (attachment) =>
        !retainedAttachments.some(
          (existing) =>
            existing.id === attachment.id ||
            (existing.type === "file" &&
              attachment.type === "file" &&
              existing.uploadedAttachmentId !== undefined &&
              existing.uploadedAttachmentId === attachment.uploadedAttachmentId &&
              existing.uploadEnvironmentId === attachment.uploadEnvironmentId),
        ),
    );
    if (abandoned.length > 0) {
      if (environmentId === undefined) releaseDraftAttachments(abandoned);
      else releaseDraftAttachments(abandoned, environmentId);
    }
    for (const image of draft.images) {
      if (
        image.previewUrl.startsWith("blob:") &&
        !retained?.images.some((existing) => existing.previewUrl === image.previewUrl)
      ) {
        URL.revokeObjectURL(image.previewUrl);
      }
    }
  }
  store.clearComposerContent(key);
  useQuestionAttachmentPreparation.setState(({ counts }) => {
    const next = { ...counts };
    delete next[key];
    return { counts: next };
  });
}

/** Clears the thread's question attachment drafts for every request outside `pendingRequestIds`. */
function pruneResolvedQuestionAttachmentDrafts(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  pendingRequestIds: ReadonlyArray<string>,
): void {
  const store = useComposerDraftStore.getState();
  const retained = store.getComposerDraft(scopeThreadRef(environmentId, threadId));
  const keys = new Set([
    ...Object.keys(store.draftsByThreadKey),
    ...Object.keys(useQuestionAttachmentPreparation.getState().counts),
  ]);
  const prefix = questionAttachmentDraftPrefix(environmentId, threadId);
  for (const key of resolvedQuestionDraftKeys(keys, prefix, pendingRequestIds)) {
    clearQuestionAttachmentDraft(DraftId.make(key), retained, environmentId);
  }
}

/** The thread's question drafts that hold attachments or chips for one of `requestIds`. */
function questionDraftIdsForRequests(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  requestIds: ReadonlySet<string>,
): DraftId[] {
  const prefix = questionAttachmentDraftPrefix(environmentId, threadId);
  return questionDraftKeysForRequests(
    Object.keys(useComposerDraftStore.getState().draftsByThreadKey),
    prefix,
    requestIds,
  ).map((key) => DraftId.make(key));
}

/**
 * Stop cancels an open question and a provider timeout expires it; neither sent the typed
 * answers, so their text, thread chips, images and files move to the thread's own draft (not a
 * queued-message edit the composer may be showing). Attachments past the composer's limit stay
 * behind and are released with the question.
 */
function returnUnsentAnswersToThreadDraft(
  environmentId: EnvironmentId,
  threadId: ThreadId,
  unansweredRequestIds: ReadonlyArray<RuntimeRequestId>,
): void {
  if (unansweredRequestIds.length === 0) return;
  const answers = usePendingUserInputAnswers.getState();
  const store = useComposerDraftStore.getState();
  const target = scopeThreadRef(environmentId, threadId);
  const currentPrompt = store.getComposerDraft(target)?.prompt ?? "";
  let prompt = currentPrompt;
  const threadContexts: ThreadContextRecord[] = [];
  for (const requestId of unansweredRequestIds) {
    const drafts = answers[userInputDraftKey(environmentId, threadId, requestId)] ?? {};
    for (const [questionId, { customAnswer }] of Object.entries(drafts)) {
      const nextPrompt = carryDisplacedCustomAnswerIntoPrompt(prompt, customAnswer);
      if (nextPrompt === prompt) continue;
      prompt = nextPrompt;
      const questionDraft = store.getComposerDraft(
        questionAttachmentDraftId(environmentId, threadId, requestId, questionId),
      );
      threadContexts.push(
        ...threadContextsReferencedByAnswer(
          customAnswer ?? "",
          questionDraft?.threadContexts ?? [],
        ),
      );
    }
  }
  let movedAttachments = false;
  for (const draftId of questionDraftIdsForRequests(
    environmentId,
    threadId,
    new Set(unansweredRequestIds),
  )) {
    const draft = store.getComposerDraft(draftId);
    if (!draft || draft.images.length + draft.files.length === 0) continue;
    // Moving replaces the thread's prompt; the combined prompt is written below.
    store.moveComposerPromptAndImages(draftId, target);
    movedAttachments = true;
  }
  if (prompt === currentPrompt && !movedAttachments) return;
  store.setPrompt(target, prompt);
  store.addThreadContexts(target, threadContexts, { appendReference: false });
}

// Resolution can come from anywhere: another device, an interrupt, the turn
// ending, or a reload over drafts for requests resolved meanwhile. One listener,
// so unsent answers and their attachments move before their drafts are pruned.
onThreadRequestsResolved(({ environmentId, threadId, pendingRequestIds, unansweredRequestIds }) => {
  returnUnsentAnswersToThreadDraft(environmentId, threadId, unansweredRequestIds);
  usePendingUserInputAnswers.setState(
    (existing) =>
      pruneResolvedUserInputDrafts(existing, environmentId, threadId, pendingRequestIds),
    true,
  );
  usePendingUserInputQuestionIndex.setState(
    (existing) =>
      pruneResolvedUserInputDrafts(existing, environmentId, threadId, pendingRequestIds),
    true,
  );
  pruneResolvedQuestionAttachmentDrafts(environmentId, threadId, pendingRequestIds);
});
