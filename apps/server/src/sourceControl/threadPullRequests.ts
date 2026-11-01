import { makeThreadPullRequests } from "@goat/source-control-core/shared/threadPullRequests";

import { sourceControlDefinitions } from "./sourceControlDefinitions.ts";

export { visibleThreadPullRequests } from "@goat/shared/threadPullRequests";

export const {
  normalizeThreadPullRequestKey,
  legacyThreadPullRequestKey,
  threadPullRequestKeysEqual,
  threadPullRequestKeyOf,
  resolveThreadPullRequestChains,
  threadPullRequestsOf,
  applyThreadPullRequestLinkUpdate,
} = makeThreadPullRequests(sourceControlDefinitions);
