import type { ChangeRequest } from "@goat/contracts";
import type { PullRequestInfo } from "./GitManager.ts";

export function toPullRequestInfo(summary: ChangeRequest): PullRequestInfo {
  return {
    number: summary.number,
    title: summary.title,
    url: summary.url,
    baseRefName: summary.baseRefName,
    headRefName: summary.headRefName,
    ...(summary.headSha !== undefined ? { headSha: summary.headSha } : {}),
    state: summary.state ?? "open",
    ...(summary.isDraft === true ? { isDraft: true } : {}),
    closedAt: summary.closedAt ?? null,
    mergedAt: summary.mergedAt ?? null,
    updatedAt: summary.updatedAt,
    ...(summary.isCrossRepository !== undefined
      ? { isCrossRepository: summary.isCrossRepository }
      : {}),
    ...(summary.headRepositoryNameWithOwner !== undefined
      ? { headRepositoryNameWithOwner: summary.headRepositoryNameWithOwner }
      : {}),
    ...(summary.headRepositoryOwnerLogin !== undefined
      ? { headRepositoryOwnerLogin: summary.headRepositoryOwnerLogin }
      : {}),
  };
}
