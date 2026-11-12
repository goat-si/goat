/** Maps Origin pull requests and comments to the shared change-request shapes. */
import type { PullRequestReviewThread } from "@goat/contracts";
import type { ProviderChangeRequest } from "@goat/source-control-core/server/PullRequestProvider";

import {
  originActor,
  originState,
  originUpdatedAt,
  type OriginAvatars,
  type OriginComment,
  type OriginPullRequest,
} from "./originPullRequests.ts";

export function toProviderChangeRequest(pullRequest: OriginPullRequest, avatars?: OriginAvatars) {
  return {
    number: pullRequest.number,
    title: pullRequest.title,
    url: pullRequest.webUrl,
    author: originActor(pullRequest.author, avatars),
    headBranch: pullRequest.head.ref,
    baseBranch: pullRequest.base.ref,
    state: originState(pullRequest),
    isDraft: pullRequest.draft === true,
    // A listing cannot afford the base comparison the detail makes, so it does not guess.
    mergeability: "unknown",
    additions: pullRequest.additions ?? 0,
    deletions: pullRequest.deletions ?? 0,
    createdAt: pullRequest.createdAt?.trim() || originUpdatedAt(pullRequest),
    closedAt: pullRequest.closedAt?.trim() || null,
    mergedAt: pullRequest.mergedAt?.trim() || null,
    updatedAt: originUpdatedAt(pullRequest),
    reviewRequestLogins: [],
    labels: (pullRequest.labels ?? []).map((label) => ({
      name: label.name,
      color: label.color?.replace(/^#/u, "") || "888888",
      description: label.description ?? null,
    })),
  } satisfies ProviderChangeRequest;
}

export const isThreadComment = (comment: OriginComment) => Boolean(comment.thread?.path);
export const editedAt = (comment: OriginComment) =>
  comment.updatedAt && comment.updatedAt !== comment.createdAt ? comment.updatedAt : null;

export function toThreads(
  comments: ReadonlyArray<OriginComment>,
  avatars: OriginAvatars,
  headSha: string | null,
): PullRequestReviewThread[] {
  const threads = new Map<string, PullRequestReviewThread>();
  for (const comment of comments) {
    const thread = comment.thread;
    if (!thread?.path) continue;
    const line = thread.endLine ?? thread.startLine ?? null;
    const existing = threads.get(thread.id) ?? {
      id: thread.id,
      path: thread.path,
      line: line !== null && line > 0 ? line : null,
      side: thread.side === "left" ? ("left" as const) : ("right" as const),
      isResolved: Boolean(thread.resolvedAt),
      // Origin anchors a thread to the version it was left on and does not move it forward.
      isOutdated: Boolean(headSha && thread.version?.headSha && thread.version.headSha !== headSha),
      comments: [],
    };
    threads.set(thread.id, {
      ...existing,
      comments: [
        ...existing.comments,
        {
          id: comment.id,
          author: originActor(comment.author, avatars),
          body: comment.body ?? "",
          createdAt: comment.createdAt,
          editedAt: editedAt(comment),
          url: null,
        },
      ],
    });
  }
  return [...threads.values()];
}
