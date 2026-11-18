import type { EnvironmentThreadShell } from "@goat/client-runtime/state/shell";
import {
  parseSideChatCommand,
  sideChatCommandOverAnswer,
} from "@goat/client-runtime/state/unsent-question-answers";

import type { ComposerDraft } from "./use-composer-drafts";

// The phone's composer takes /btw as /side (features/threads/sideChatCommand.ts); answers do too,
// so one spelling never works in the composer and fails in a question card (coordinator D1 (b)).
const BTW_COMMAND = /^\/btw(?=\s|$)/i;

/** A side chat cannot start from a side chat or a sub-agent, as the composer's command says. */
export function canStartSideChat(thread: Pick<EnvironmentThreadShell, "sideChatOf" | "lineage">) {
  return thread.sideChatOf == null && thread.lineage.relationshipToParent !== "subagent";
}

/** Whether a question's draft holds attachments or chips, which keep "/side ..." an answer. */
export function questionDraftHasContent(draft: ComposerDraft | undefined) {
  return (draft?.attachments.length ?? 0) > 0 || (draft?.context?.records.length ?? 0) > 0;
}

/**
 * The first question, in order, whose typed answer is a side chat command, with its prompt; the
 * rule is client-runtime's sideChatCommandOverAnswer, shared with web.
 */
export function sideChatAnswer<Q extends { readonly id: string }>(input: {
  readonly questions: ReadonlyArray<Q>;
  readonly customAnswer: (question: Q) => string | undefined;
  readonly hasAttachmentsOrContext: (question: Q) => boolean;
  /** Asked only once an answer reads as a side chat command. */
  readonly sideChatAvailable: () => boolean;
}): { readonly question: Q; readonly prompt: string } | null {
  for (const question of input.questions) {
    const answer = (input.customAnswer(question) ?? "").trim().replace(BTW_COMMAND, "/side");
    if (parseSideChatCommand(answer) === null) continue;
    const command = sideChatCommandOverAnswer({
      answer,
      sideChatAvailable: input.sideChatAvailable(),
      hasAttachmentsOrContext: input.hasAttachmentsOrContext(question),
    });
    if (command !== null) return { question, prompt: command.prompt };
  }
  return null;
}
