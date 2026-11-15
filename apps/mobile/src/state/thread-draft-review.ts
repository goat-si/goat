import type { EnvironmentId, ThreadId } from "@goat/contracts";
import { PROVIDER_SEND_TURN_MAX_ATTACHMENTS } from "@goat/contracts";
import { upgradeLegacyContextMessage } from "@goat/shared/composerContextLegacy";

import * as Dialog from "../components/ui/Dialog";
import { reidentifyComposerContext } from "../lib/composerContext";
import type { DraftComposerImageAttachment } from "../lib/composerImages";
import { scopedThreadKey } from "../lib/scopedEntities";
import { uuidv4 } from "../lib/uuid";
import {
  appendComposerDraftAttachments,
  insertComposerDraftContext,
  useComposerDraft,
} from "./use-composer-drafts";
import { setPendingConnectionError } from "./use-remote-environment-registry";

export function appendReviewCommentToDraft(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly attachments?: ReadonlyArray<DraftComposerImageAttachment>;
}): void {
  const threadKey = scopedThreadKey(input.environmentId, input.threadId);
  const upgraded = upgradeLegacyContextMessage(input.text);
  if (
    !insertComposerDraftContext(
      threadKey,
      reidentifyComposerContext(upgraded.text, upgraded.records, uuidv4),
    )
  ) {
    Dialog.alert("Too many context items", "Remove some context from the draft and try again.");
    return;
  }
  if (input.attachments && input.attachments.length > 0) {
    const rejectedCount = appendComposerDraftAttachments(threadKey, input.attachments, {
      appendReference: true,
    });
    if (rejectedCount > 0) {
      setPendingConnectionError(
        `${rejectedCount} comment attachment${rejectedCount === 1 ? " was" : "s were"} not added. Messages can contain at most ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} attachments.`,
      );
    }
  }
}

export function useThreadDraftForThread(input: {
  readonly environmentId?: EnvironmentId;
  readonly threadId?: ThreadId;
}) {
  const threadKey =
    input.environmentId && input.threadId
      ? scopedThreadKey(input.environmentId, input.threadId)
      : null;
  const draft = useComposerDraft(threadKey);

  return {
    draftMessage: draft.text,
    draftContext: draft.context,
    draftAttachments: draft.attachments,
  };
}
