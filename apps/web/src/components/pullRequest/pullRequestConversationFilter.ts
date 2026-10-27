import {
  isPullRequestCommentFinished,
  pullRequestConversationItemComments,
  pullRequestReviewOutcome,
  type PullRequestConversationItem,
} from "./pullRequestDetail.logic";

function isPullRequestVerdict(reviewState: string | null): boolean {
  const outcome = pullRequestReviewOutcome(reviewState);
  return outcome === "approved" || outcome === "changes-requested";
}

export function filterPullRequestConversationItems(
  items: ReadonlyArray<PullRequestConversationItem>,
  filter: { readonly bots: boolean; readonly resolved: boolean },
): ReadonlyArray<PullRequestConversationItem> {
  return items.filter((item) =>
    // Matching any member keeps the finding beside a human reply to a bot.
    pullRequestConversationItemComments(item).some(
      (comment) =>
        (filter.bots ||
          comment.author?.isBot !== true ||
          isPullRequestVerdict(comment.reviewState)) &&
        (filter.resolved ||
          !isPullRequestCommentFinished(comment, item.kind === "thread" ? item.thread : undefined)),
    ),
  );
}
