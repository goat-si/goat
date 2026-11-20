import type { ThreadLinkedPullRequest, ThreadPullRequestLink } from "@goat/contracts";
import {
  legacyThreadPullRequestKey,
  resolveThreadCurrentPullRequestLink,
  threadPullRequestKeysEqual,
} from "@goat/client-runtime/thread-pull-requests";

export function threadPullRequestPanelTarget(thread: {
  readonly projectId: string;
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly linkedPullRequest?: ThreadLinkedPullRequest | null | undefined;
  readonly branchPullRequest?: ThreadLinkedPullRequest | null | undefined;
}) {
  const current = resolveThreadCurrentPullRequestLink(thread.pullRequests ?? []);
  const legacy = thread.linkedPullRequest;
  if (
    current !== null &&
    legacy != null &&
    threadPullRequestKeysEqual(current, legacyThreadPullRequestKey(legacy))
  ) {
    return legacy;
  }
  if (current !== null) {
    return {
      projectId: thread.projectId,
      host: current.host,
      repository: current.repository,
      number: current.number,
      url: current.url,
    };
  }
  return legacy ?? thread.branchPullRequest ?? null;
}
