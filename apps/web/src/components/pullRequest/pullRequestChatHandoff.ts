import type { PullRequestDetailView, ScopedThreadRef } from "@goat/contracts";
import { type DraftId, useComposerDraftStore } from "~/composerDraftStore";
import {
  buildPullRequestCommentContext,
  buildPullRequestContext,
  type PullRequestChatSubject,
} from "./pullRequestDetail.logic";
import { writeHandoffToComposer } from "./usePullRequestActions";

export function addPullRequestCommentToComposer(
  detail: Pick<
    PullRequestDetailView,
    "number" | "title" | "url" | "headBranch" | "baseBranch" | "state" | "isDraft" | "reviewThreads"
  >,
  target: ScopedThreadRef | DraftId,
  subject: PullRequestChatSubject,
): boolean {
  const thread =
    subject.kind === "comment"
      ? detail.reviewThreads.find((candidate) =>
          candidate.comments.some((comment) => comment.id === subject.comment.id),
        )
      : undefined;
  const comment = buildPullRequestCommentContext(
    detail,
    thread === undefined ? subject : { kind: "thread", thread },
  );
  if (comment === null) return false;
  const store = useComposerDraftStore.getState();
  const hasReference = (store.getComposerDraft(target)?.reviewComments ?? []).some(
    (existing) => existing.pullRequest?.url === detail.url,
  );
  writeHandoffToComposer(target, {
    prompt: "",
    reviewComments: hasReference ? [comment] : [buildPullRequestContext(detail), comment],
  });
  return true;
}
