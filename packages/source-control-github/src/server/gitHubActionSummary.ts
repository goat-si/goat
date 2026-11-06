import { toMergeMethod } from "./gitHubMergeMethod.ts";
import type { ProviderChangeRequestSummary } from "@goat/source-control-core/server/PullRequestProvider";
import type { PullRequestActionSummary } from "./pullRequestMutations.graphql.ts";
import { trimmed, toActor, toState } from "./gitHubPullRequestJson.ts";

export function toPullRequestActionSummary(
  raw: PullRequestActionSummary | null | undefined,
): ProviderChangeRequestSummary | undefined {
  if (raw == null) return undefined;
  const autoMergeMethod = toMergeMethod(raw.autoMergeRequest?.mergeMethod);
  return {
    number: raw.number,
    title: raw.title,
    url: raw.url,
    headBranch: raw.headRefName,
    baseBranch: raw.baseRefName,
    state: toState(raw),
    isDraft: raw.isDraft,
    updatedAt: raw.updatedAt,
    mergedAt: trimmed(raw.mergedAt),
    closedAt: trimmed(raw.closedAt),
    author: toActor(raw.author),
    headSha: raw.headRefOid,
    autoMergeEnabled: raw.autoMergeRequest !== null,
    ...(autoMergeMethod === undefined ? {} : { autoMergeMethod }),
  };
}
