import { isUsageLimitsCommand } from "@goat/shared/usageLimits";
import { parseCodexFeedbackCommand } from "@goat/client-runtime/state/threads";
import { isStandaloneForkCommand } from "../../composer-logic";
import { sideChatCommandOverAnswer } from "@goat/client-runtime/state/unsent-question-answers";
import type { ChatComposerProps } from "./ChatComposer";
import {
  composerDraftHasUserContent,
  type ComposerThreadDraftState,
} from "../../composerDraftStore";
import { stripInlineContextReferences } from "../../lib/composerContextReferences";
import { filterTerminalContextsWithText } from "../../lib/terminalContext";

export function composerSideChatIsLocal(
  prompt: string,
  available: boolean,
  draft: ComposerThreadDraftState,
  attachments: ComposerThreadDraftState,
  options: { props: ChatComposerProps; selectedProvider: string },
): boolean {
  const hasAttachmentsOrContext =
    attachments.images.length +
      attachments.files.length +
      filterTerminalContextsWithText(draft.terminalContexts).length +
      draft.previewAnnotations.length +
      draft.reviewComments.length +
      attachments.threadContexts.length >
    0;
  const props = options.props;
  return (
    composerTextCommandIsLocal(prompt, {
      hasAttachmentsOrContext,
      usageHasContext: composerDraftHasUserContent({ ...draft, prompt: "" }),
      usageLimits: props.onUsageLimitsCommand !== undefined,
      codexFeedback: options.selectedProvider === "codex" && props.multipleModelSelections === null,
      fork:
        props.forkCommand !== undefined &&
        props.editingQueuedAttachments === null &&
        props.activePendingProgress === null,
    }) ||
    sideChatCommandOverAnswer({
      answer: stripInlineContextReferences(prompt).trim(),
      sideChatAvailable: available,
      hasAttachmentsOrContext,
    }) !== null
  );
}

export function composerTextCommandIsLocal(
  text: string,
  options: {
    hasAttachmentsOrContext: boolean;
    usageHasContext?: boolean;
    usageLimits: boolean;
    codexFeedback: boolean;
    fork: boolean;
  },
): boolean {
  if (options.fork && isStandaloneForkCommand(text)) return true;
  return (
    (options.usageLimits &&
      !(options.usageHasContext ?? options.hasAttachmentsOrContext) &&
      isUsageLimitsCommand(text)) ||
    (!options.hasAttachmentsOrContext &&
      options.codexFeedback &&
      parseCodexFeedbackCommand(stripInlineContextReferences(text).trim()) !== null)
  );
}
