import type { ScopedThreadRef } from "@goat/contracts";

import { canStartSideChat, questionDraftHasContent } from "../../state/answer-side-chat";
import { appAtomRegistry } from "../../state/atom-registry";
import { questionAttachmentDraftKey } from "../../state/question-attachments";
import { environmentThreadShells } from "../../state/threads";
import { composerDraftsAtom } from "../../state/use-composer-drafts";
import { isEnvironmentConnected } from "../../state/use-remote-environment-registry";
import { useSideChatCommand } from "../threads/useSideChatCommand";
import type { DecisionInboxSideChat } from "./useDecisionInbox";

/** "/side ..." typed in the Decisions inbox opens that thread's side chat, as in its composer. */
export function useDecisionInboxSideChat(): DecisionInboxSideChat {
  const sideChatCommand = useSideChatCommand();
  const shell = (ref: ScopedThreadRef) =>
    appAtomRegistry.get(environmentThreadShells.threadShellAtom(ref));
  return {
    available: (ref) => {
      const thread = shell(ref);
      return thread !== null && canStartSideChat(thread);
    },
    hasAttachmentsOrContext: (ref, requestId, questionId) =>
      questionDraftHasContent(
        appAtomRegistry.get(composerDraftsAtom)[
          questionAttachmentDraftKey(ref.environmentId, ref.threadId, requestId, questionId)
        ],
      ),
    open: async (ref, prompt) => {
      const thread = shell(ref);
      if (thread === null) return false;
      return sideChatCommand({
        thread,
        // No composer draft holds the command, so nothing is cleared.
        threadKey: `decisions:${ref.environmentId}:${ref.threadId}`,
        text: `/side ${prompt}`,
        hasAttachmentsOrContext: false,
        connected: isEnvironmentConnected(ref.environmentId),
      });
    },
  };
}
