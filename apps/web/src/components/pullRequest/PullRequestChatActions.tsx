import type { PullRequestComment, PullRequestReviewThread } from "@goat/contracts";
import { MessageSquareIcon } from "~/components/solar";
import { Button } from "../ui/button";
import { visibleBody, type PullRequestChatSubject } from "./pullRequestDetail.logic";

/**
 * What Add to chat hands over for a remark: a remark on a line goes as its whole conversation,
 * the way fixing one does. Null when there are no words in it to talk about.
 */
export function chatSubject(
  comment: PullRequestComment,
  thread: PullRequestReviewThread | undefined,
): PullRequestChatSubject | null {
  if (thread !== undefined) {
    return thread.comments.some((entry) => visibleBody(entry.body) !== null)
      ? { kind: "thread", thread }
      : null;
  }
  return visibleBody(comment.body) === null ? null : { kind: "comment", comment };
}

export function AddToChatButton({ onClick }: { onClick: () => void }) {
  return (
    <Button size="xs" variant="ghost" className="shrink-0" onClick={onClick}>
      {/* Wrapped like Fix's label so both sit on the header's baseline. */}
      <span className="inline-flex items-baseline gap-1">
        <MessageSquareIcon className="size-3 self-center" />
        <span>Add to chat</span>
      </span>
    </Button>
  );
}
