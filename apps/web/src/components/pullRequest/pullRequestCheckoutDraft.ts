import type { GitPreparePullRequestThreadResult } from "@goat/contracts";

import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";

/** The draft carries the pull request until its first send makes it a thread, which links it. */
export function markDraftCheckoutPullRequest(
  draftId: DraftId,
  prepared: Pick<GitPreparePullRequestThreadResult, "pullRequest" | "branch">,
) {
  useComposerDraftStore.getState().setDraftThreadContext(draftId, {
    checkoutPullRequest: { url: prepared.pullRequest.url, branch: prepared.branch },
  });
}
