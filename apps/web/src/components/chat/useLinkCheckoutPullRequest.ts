import type { EnvironmentId, ScopedThreadRef } from "@goat/contracts";

import { checkoutPullRequestUrlToLink } from "../../composerDraftCheckoutPullRequest";
import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { usePullRequestLinking } from "../../hooks/usePullRequestLinking";

/**
 * Links the pull request a draft was checked out for to the thread its first send creates. Read
 * the live draft before the send: the draft is finalized away once the thread exists.
 */
export function useLinkCheckoutPullRequest(environmentId: EnvironmentId) {
  const linking = usePullRequestLinking(environmentId);
  return {
    /** The pull request on the live draft that matches the branch being dispatched. */
    read: (draftId: DraftId | null, dispatchedBranch: string | null) => {
      if (draftId === null || dispatchedBranch === null) return null;
      const draft = useComposerDraftStore.getState().getDraftSession(draftId);
      if (draft?.branch !== dispatchedBranch) return null;
      return checkoutPullRequestUrlToLink(draft);
    },
    /** Best effort: the thread already exists, so a failed link is only logged. */
    link: (threadRef: ScopedThreadRef, url: string | null) => {
      if (url === null) return;
      linking.changeLink(threadRef, url, true).catch((error: unknown) => {
        console.warn("Failed to link the checked-out pull request to its thread.", error);
      });
    },
  };
}
