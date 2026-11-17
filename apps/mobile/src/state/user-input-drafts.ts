import type { EnvironmentId, RuntimeRequestId, ThreadId } from "@goat/contracts";
import {
  seedUserInputDraftAnswers,
  type ThreadUserInputQuestion,
  userInputDraftKey,
} from "@goat/client-runtime/state/thread-requests";
import { appendAnswerToDraft } from "@goat/client-runtime/state/user-input-draft";
import { Atom } from "effect/reactivity";

import {
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../lib/threadActivity";
import { scopedThreadKey } from "../lib/scopedEntities";
import { appAtomRegistry } from "./atom-registry";
import { questionAttachmentDraftKey, questionAttachmentDraftPrefix } from "./question-attachments";
import {
  type ComposerDraft,
  mergeComposerDraftContentState,
  restoreMissingComposerFileReferences,
} from "./use-composer-drafts";

export const userInputDraftsByRequestKeyAtom = Atom.make<
  Record<string, Record<string, PendingUserInputDraftAnswer>>
>({}).pipe(Atom.keepAlive, Atom.withLabel("mobile:user-input-drafts"));

// Writes start from the suggested answer the user was looking at.
function seededDraft(
  drafts: Record<string, PendingUserInputDraftAnswer> | undefined,
  question: ThreadUserInputQuestion,
): PendingUserInputDraftAnswer | undefined {
  return seedUserInputDraftAnswers([question], drafts ?? {})[question.id];
}

export function setUserInputDraftOption(
  requestKey: string,
  question: ThreadUserInputQuestion,
  value: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [question.id]: togglePendingUserInputOptionSelection(
        question,
        seededDraft(current[requestKey], question),
        value,
      ),
    },
  });
}

export function setUserInputDraftCustomAnswer(
  requestKey: string,
  question: ThreadUserInputQuestion,
  customAnswer: string,
): void {
  const current = appAtomRegistry.get(userInputDraftsByRequestKeyAtom);
  appAtomRegistry.set(userInputDraftsByRequestKeyAtom, {
    ...current,
    [requestKey]: {
      ...current[requestKey],
      [question.id]: setPendingUserInputCustomAnswer(
        question,
        seededDraft(current[requestKey], question),
        customAnswer,
      ),
    },
  });
}

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
  const next = { ...input.drafts };
  let changed = false;
  for (const requestId of input.unansweredRequestIds) {
    const answers = input.answers[userInputDraftKey(environmentId, threadId, requestId)] ?? {};
    for (const questionId of questionIds(input.drafts, answers, prefix, requestId)) {
      const question =
        input.drafts[questionAttachmentDraftKey(environmentId, threadId, requestId, questionId)];
      const answer = answers[questionId]?.customAnswer;
      const attachments = question?.attachments ?? [];
      if (!answer?.trim() && attachments.length === 0) continue;
      // The join web uses; mergeComposerDraftText would drop an answer equal to existing text.
      const draft = next[threadKey] ?? { text: "", attachments: [] };
      next[threadKey] = { ...draft, text: appendAnswerToDraft(draft.text, answer) };
      const merged = mergeComposerDraftContentState(next, threadKey, {
        text: "",
        attachments,
        ...(question?.context ? { context: question.context } : {}),
      })[threadKey];
      if (merged) next[threadKey] = merged;
      changed = true;
    }
  }
  const merged = next[threadKey];
  if (!changed || merged === undefined) return input.drafts;
  // The thread composer shows non-image files only as chips, so moved files get theirs.
  next[threadKey] = restoreMissingComposerFileReferences(merged, merged.attachments.slice(before));
  return next;
}
