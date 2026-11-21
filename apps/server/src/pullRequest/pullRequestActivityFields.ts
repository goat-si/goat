import type { ProviderChangeRequestActivity } from "@goat/source-control-core/server/PullRequestProvider";

/** A host's overview threads (GitLab's), passed on only when the host reported the list. */
export const withOverviewThreads = (activity: ProviderChangeRequestActivity) =>
  activity.overviewThreads === undefined ? {} : { overviewThreads: activity.overviewThreads };
