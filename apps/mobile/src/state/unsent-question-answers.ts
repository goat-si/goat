import type { EnvironmentId, RuntimeRequestId, ThreadId } from "@goat/contracts";
import { userInputDraftKey } from "@goat/client-runtime/state/thread-requests";

import type { PendingUserInputDraftAnswer } from "../lib/threadActivity";
import { scopedThreadKey } from "../lib/scopedEntities";
import { questionAttachmentDraftKey, questionAttachmentDraftPrefix } from "./question-attachments";
import {
  type ComposerDraft,
  mergeComposerDraftContentState,
  restoreMissingComposerFileReferences,
} from "./use-composer-drafts";

/** Question ids of `requestId` with a typed answer or a question draft, in answer order. */
function questionIds(
  drafts: Readonly<Record<string, ComposerDraft>>,
  answers: Readonly<Record<string, PendingUserInputDraftAnswer>>,
  prefix: string,
  requestId: string,
): string[] {
  const ids = new Set(Object.keys(answers));
  for (const key of Object.keys(drafts)) {
    if (!key.startsWith(prefix)) continue;
    try {
      const [draftRequestId, questionId] = JSON.parse(
        decodeURIComponent(key.slice(prefix.length)),
      ) as unknown[];
      if (draftRequestId === requestId && typeof questionId === "string") ids.add(questionId);
    } catch {
      // Keys outside the question shape are not this request's.
    }
  }
  return [...ids];
}

/**
 * Stop cancels an open question and a provider timeout expires it; neither sent the typed
 * answers, so their text, chips and attachments merge into the thread's own draft before the
 * question drafts are pruned. Attachments past the composer's limit stay behind and are
 * released with the question.
 */
export function returnUnsentAnswersToThreadDraft(input: {
  readonly drafts: Record<string, ComposerDraft>;
  readonly answers: Readonly<Record<string, Record<string, PendingUserInputDraftAnswer>>>;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly unansweredRequestIds: ReadonlyArray<RuntimeRequestId>;
}): Record<string, ComposerDraft> {
  const { environmentId, threadId } = input;
  const threadKey = scopedThreadKey(environmentId, threadId);
  const prefix = questionAttachmentDraftPrefix(environmentId, threadId);
  const before = input.drafts[threadKey]?.attachments.length ?? 0;
  let next = input.drafts;
  for (const requestId of input.unansweredRequestIds) {
    const answers = input.answers[userInputDraftKey(environmentId, threadId, requestId)] ?? {};
    for (const questionId of questionIds(input.drafts, answers, prefix, requestId)) {
      const question =
        input.drafts[questionAttachmentDraftKey(environmentId, threadId, requestId, questionId)];
      const text = answers[questionId]?.customAnswer?.trim() ?? "";
      const attachments = question?.attachments ?? [];
      if (text.length === 0 && attachments.length === 0) continue;
      next = mergeComposerDraftContentState(next, threadKey, {
        text,
        attachments,
        ...(question?.context ? { context: question.context } : {}),
      });
    }
  }
  const merged = next[threadKey];
  if (merged === undefined || merged === input.drafts[threadKey]) return next;
  // The thread composer shows non-image files only as chips, so moved files get theirs.
  return {
    ...next,
    [threadKey]: restoreMissingComposerFileReferences(merged, merged.attachments.slice(before)),
  };
}
