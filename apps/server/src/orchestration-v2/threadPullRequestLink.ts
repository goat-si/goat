import {
  type OrchestrationV2AppThread,
  type ThreadLinkedPullRequest,
  type ThreadPullRequestLink,
  type ThreadPullRequestWatch,
} from "@goat/contracts";
import { canonicalizeGitCafePullRequestUrl } from "@goat/source-control-definitions/registry";
import * as DateTime from "effect/DateTime";

import {
  legacyThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestsOf,
} from "../sourceControl/threadPullRequests.ts";

export function withPullRequestWatch(
  link: ThreadPullRequestLink,
  watch: ThreadPullRequestWatch | undefined,
): ThreadPullRequestLink {
  const { watch: previous, endedWatch, ...rest } = link;
  if (watch !== undefined) return { ...rest, watch };
  const ended = previous ?? endedWatch;
  if (ended === undefined) return rest;
  // Kept context is told when the watch ends (or dropped with it); an ended watch never holds it.
  const { heldContext: _told, ...told } = ended;
  return { ...rest, endedWatch: told };
}

export function legacyPullRequestLink(
  thread: OrchestrationV2AppThread,
  linked: ThreadLinkedPullRequest,
  now: DateTime.Utc,
): ThreadPullRequestLink {
  const key = legacyThreadPullRequestKey(linked);
  const existing = threadPullRequestsOf(thread).find((link) =>
    threadPullRequestKeysEqual(link, key),
  );
  return withPullRequestWatch(
    {
      ...key,
      url: canonicalizeGitCafePullRequestUrl(linked.url),
      source: "manual",
      linkedAt: DateTime.formatIso(now),
      snapshot: null,
      stack: null,
      ...(existing?.repositoryWebUrl !== undefined && {
        repositoryWebUrl: existing.repositoryWebUrl,
      }),
      ...(existing?.endedWatch && { endedWatch: existing.endedWatch }),
    },
    existing?.watch,
  );
}
