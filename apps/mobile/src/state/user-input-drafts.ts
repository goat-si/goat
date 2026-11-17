import type { EnvironmentId, RuntimeRequestId, ThreadId } from "@goat/contracts";
import {
  seedUserInputDraftAnswers,
  type ThreadUserInputQuestion,
  userInputDraftKey,
} from "@goat/client-runtime/state/thread-requests";
import { appendAnswerToDraft } from "@goat/client-runtime/state/user-input-draft";
import { questionDraftKeysForRequests } from "@goat/client-runtime/state/unsent-question-answers";
import { Atom } from "effect/reactivity";

import {
  setPendingUserInputCustomAnswer,
  togglePendingUserInputOptionSelection,
  type PendingUserInputDraftAnswer,
} from "../lib/threadActivity";
import { scopedThreadKey } from "../lib/scopedEntities";
import { referencedComposerContext } from "../lib/composerContext";
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

/**
 * The question drafts of `requestId` with a typed answer or a question draft, in answer order;
 * the draft-only ones come from the rule web shares (client-runtime unsent-question-answers).
 */
function unsentQuestions(
  drafts: Readonly<Record<string, ComposerDraft>>,
  answers: Readonly<Record<string, PendingUserInputDraftAnswer>>,
  key: (questionId: string) => string,
  prefix: string,
  requestId: string,
): Array<{ readonly key: string; readonly answer: string | undefined }> {
  const byKey = new Map<string, string | undefined>();
  for (const [questionId, draft] of Object.entries(answers)) {
    byKey.set(key(questionId), draft.customAnswer);
  }
  for (const draftKey of questionDraftKeysForRequests(
    Object.keys(drafts),
    prefix,
    new Set([requestId]),
  )) {
    if (!byKey.has(draftKey)) byKey.set(draftKey, undefined);
  }
  return [...byKey].map(([draftKey, answer]) => ({ key: draftKey, answer }));
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
    const questionKey = (questionId: string) =>
      questionAttachmentDraftKey(environmentId, threadId, requestId, questionId);
    for (const { key, answer } of unsentQuestions(
      input.drafts,
      answers,
      questionKey,
      prefix,
      requestId,
    )) {
      const question = input.drafts[key];
      const attachments = question?.attachments ?? [];
      if (!answer?.trim() && attachments.length === 0) continue;
      // A question draft keeps deleted chips for undo; only the answer's own chips come back.
      const context = referencedComposerContext(answer ?? "", question?.context);
      // The join web uses; mergeComposerDraftText would drop an answer equal to existing text.
      const draft = next[threadKey] ?? { text: "", attachments: [] };
      next[threadKey] = { ...draft, text: appendAnswerToDraft(draft.text, answer) };
      const merged = mergeComposerDraftContentState(next, threadKey, {
        text: "",
        attachments,
        ...(context ? { context } : {}),
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
