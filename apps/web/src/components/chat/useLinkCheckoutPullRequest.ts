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
    /** The pull request to link, read from the live draft; null when it does not apply. */
    read: (draftId: DraftId | null) =>
      draftId === null
        ? null
        : checkoutPullRequestUrlToLink(useComposerDraftStore.getState().getDraftSession(draftId)),
    /** Best effort: the thread already exists, so a failed link is only logged. */
    link: (threadRef: ScopedThreadRef, url: string | null) => {
      if (url === null) return;
      linking.changeLink(threadRef, url, true).catch((error: unknown) => {
        console.warn("Failed to link the checked-out pull request to its thread.", error);
      });
    },
  };
}
