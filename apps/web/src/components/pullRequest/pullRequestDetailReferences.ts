import { sourceControlClients } from "@goat/client-runtime/source-control-clients";
import type { PullRequestDetail, PullRequestRef, ScopedThreadRef } from "@goat/contracts";

import { resolvePullRequestReferenceHost } from "./pullRequestDetail.logic";
import { pullRequestMarkdownPlugins } from "./pullRequestMarkdown.logic";

export function resolvePullRequestReference(
  requestedReference: PullRequestRef,
  repositoryIdentity: Parameters<typeof resolvePullRequestReferenceHost>[1],
  supportsThreadPullRequests: boolean,
): PullRequestRef {
  return supportsThreadPullRequests
    ? resolvePullRequestReferenceHost(requestedReference, repositoryIdentity)
    : {
        projectId: requestedReference.projectId,
        repository: requestedReference.repository,
        number: requestedReference.number,
      };
}

export function pullRequestMarkdownContext(
  detail: Pick<PullRequestDetail, "provider" | "url" | "repository"> | null,
  threadRef: ScopedThreadRef | null,
) {
  return {
    remarkPlugins: pullRequestMarkdownPlugins(detail),
    lineBreaks: sourceControlClients.find(detail?.provider ?? "")?.hardLineBreaks ?? false,
    threadRef,
    repository: detail?.repository ?? null,
  };
}

export function pullRequestStackReference(
  detail: Pick<PullRequestDetail, "url" | "capabilities"> | null,
  reference: PullRequestRef,
  supportsThreadPullRequests: boolean,
) {
  return detail === null || detail.capabilities.stacks !== true || !supportsThreadPullRequests
    ? null
    : {
        ...reference,
        host: reference.host ?? sourceControlClients.parseChangeRequestUrl(detail.url)?.link.host,
      };
}
