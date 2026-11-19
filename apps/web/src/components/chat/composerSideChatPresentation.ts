import { sideChatCommandOverAnswer } from "@goat/client-runtime/state/unsent-question-answers";
import type { ComposerThreadDraftState } from "../../composerDraftStore";
import { filterTerminalContextsWithText } from "../../lib/terminalContext";

export function composerSideChatIsLocal(
  prompt: string,
  available: boolean,
  draft: ComposerThreadDraftState,
  attachments: ComposerThreadDraftState,
): boolean {
  return (
    sideChatCommandOverAnswer({
      answer: prompt,
      sideChatAvailable: available,
      hasAttachmentsOrContext:
        attachments.images.length +
          attachments.files.length +
          filterTerminalContextsWithText(draft.terminalContexts).length +
          draft.previewAnnotations.length +
          draft.reviewComments.length +
          attachments.threadContexts.length >
          0 || draft.replyTo !== null,
    }) !== null
  );
}
