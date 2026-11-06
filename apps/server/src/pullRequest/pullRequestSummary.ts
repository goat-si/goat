import type { PullRequestSummary } from "@goat/contracts";
import type {
  ProviderChangeRequestSummary,
  ProviderChangeRequestDetail,
} from "@goat/source-control-core/server/PullRequestProvider";
import type { SupportedProject } from "./PullRequestService.ts";

export const toPullRequestSummary = (
  project: SupportedProject,
  changeRequest: ProviderChangeRequestSummary | ProviderChangeRequestDetail,
  observedAt: number,
  reply = false,
): PullRequestSummary => ({
  provider: project.api.kind,
  projectId: project.project.id,
  repository: project.repository,
  number: changeRequest.number,
  title: changeRequest.title,
  url: changeRequest.url,
  state: changeRequest.state,
  headBranch: changeRequest.headBranch,
  baseBranch: changeRequest.baseBranch,
  // An action reply may not carry these, and null would erase a time a client already holds.
  ...(changeRequest.closedAt === undefined && reply
    ? {}
    : { closedAt: changeRequest.closedAt ?? null }),
  ...(changeRequest.mergedAt === undefined && reply
    ? {}
    : { mergedAt: changeRequest.mergedAt ?? null }),
  updatedAt: changeRequest.updatedAt,
  observedAt,
  ...(changeRequest.isDraft === undefined ? {} : { isDraft: changeRequest.isDraft }),
  ...(changeRequest.author === undefined ? {} : { author: changeRequest.author }),
  ...(changeRequest.additions === undefined ? {} : { additions: changeRequest.additions }),
  ...(changeRequest.deletions === undefined ? {} : { deletions: changeRequest.deletions }),
  ...(changeRequest.changedFiles === undefined ? {} : { changedFiles: changeRequest.changedFiles }),
  ...(changeRequest.reviewDecision === undefined
    ? {}
    : { reviewDecision: changeRequest.reviewDecision }),
  ...(changeRequest.checksState === undefined ? {} : { checksState: changeRequest.checksState }),
  ...(changeRequest.mergeability === undefined ? {} : { mergeability: changeRequest.mergeability }),
  ...(changeRequest.stack === undefined ? {} : { stack: changeRequest.stack }),
  ...(changeRequest.headSha?.trim() ? { headSha: changeRequest.headSha.trim() } : {}),
  ...(changeRequest.autoMergeEnabled === undefined
    ? {}
    : { autoMergeEnabled: changeRequest.autoMergeEnabled }),
  ...(changeRequest.autoMergeMethod === undefined
    ? {}
    : { autoMergeMethod: changeRequest.autoMergeMethod }),
});

export function matchesFilterRepository(
  item: { readonly upstream: boolean; readonly repository: string },
  input: {
    readonly includeUpstream?: boolean | undefined;
    readonly repository?: string | undefined;
  },
) {
  return (
    (input.includeUpstream || !item.upstream) &&
    (input.repository === undefined ||
      item.repository.toLowerCase() === input.repository.toLowerCase())
  );
}
