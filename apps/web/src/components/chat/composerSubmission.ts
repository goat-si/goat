import { PROVIDER_SEND_TURN_MAX_INPUT_CHARS } from "@goat/contracts";
import { expandAssistantCitationsForProvider } from "@goat/shared/assistantCitations";
import { parseSideChatCommand } from "../sideChat/sideChat.logic";

type ComposerSubmitEvent = { preventDefault: () => void };

export function resumeEmptyComposer(
  event: ComposerSubmitEvent | undefined,
  blocked: boolean,
  resume: () => void,
): boolean {
  event?.preventDefault();
  if (blocked) return false;
  resume();
  return true;
}

type ComposerSubmissionInput = {
  prompt: string;
  providerInput?: string;
  submissionTarget: "provider-turn" | "pending-user-input";
};

export function getComposerPromptLengthValidationMessage(prompt: string): string | null {
  const normalizedPrompt = prompt.trim();
  const inputLength = Math.max(
    normalizedPrompt.length,
    expandAssistantCitationsForProvider(normalizedPrompt).length,
  );
  const excessCharacters = inputLength - PROVIDER_SEND_TURN_MAX_INPUT_CHARS;
  if (excessCharacters <= 0) return null;

  const characterLabel = excessCharacters === 1 ? "character" : "characters";
  return `Prompt is ${excessCharacters.toLocaleString("en-US")} ${characterLabel} over the ${PROVIDER_SEND_TURN_MAX_INPUT_CHARS.toLocaleString("en-US")}-character limit. Shorten or split it before sending.`;
}

export function getComposerSubmissionValidationMessage(
  options: ComposerSubmissionInput,
): string | null {
  return options.submissionTarget === "provider-turn"
    ? getComposerPromptLengthValidationMessage(options.providerInput ?? options.prompt)
    : null;
}

// Answering a question responds to the open request instead of starting a provider turn, so
// provider and turn-send state must not block it. Its own attachments and connection still do.
export function isComposerSubmissionBlocked(input: {
  submissionTarget: ComposerSubmissionInput["submissionTarget"];
  noProviderAvailable: boolean;
  sendDisabledReason: string | null;
  attachmentBlockReason: string | null;
  environmentUnavailable: boolean;
}): boolean {
  return input.submissionTarget === "pending-user-input"
    ? input.attachmentBlockReason !== null || input.environmentUnavailable
    : input.noProviderAvailable || input.sendDisabledReason !== null;
}

/**
 * \`/side\` asks in the side chat, so typed while a question is open it opens the side chat and
 * leaves the question pending. Where no side chat can start, or the answer carries attachments
 * or context, the text stays a literal answer.
 */
export function sideChatCommandOverAnswer(input: {
  readonly answer: string;
  readonly sideChatAvailable: boolean;
  readonly hasAttachmentsOrContext: boolean;
}): { readonly prompt: string } | null {
  if (!input.sideChatAvailable || input.hasAttachmentsOrContext) return null;
  return parseSideChatCommand(input.answer.trim());
}

export function submitComposerDraft(
  options: ComposerSubmissionInput & {
    event: ComposerSubmitEvent | undefined;
    onSend: (event?: ComposerSubmitEvent) => boolean | void;
  },
): { validationMessage: string | null; didDispatch: boolean } {
  const validationMessage = getComposerSubmissionValidationMessage(options);
  if (validationMessage) {
    options.event?.preventDefault();
    return { validationMessage, didDispatch: false };
  }

  if (options.onSend(options.event) === false) {
    options.event?.preventDefault();
    return { validationMessage: null, didDispatch: false };
  }
  return { validationMessage: null, didDispatch: true };
}
