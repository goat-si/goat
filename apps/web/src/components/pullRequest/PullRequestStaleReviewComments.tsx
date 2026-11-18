import { Button } from "../ui/button";
import type { PendingReviewComment } from "./pullRequestReviewStore";

export function PullRequestStaleReviewComments({
  comments,
  moving,
  canMove,
  onMove,
  onCancel,
}: {
  readonly comments: readonly PendingReviewComment[];
  readonly moving: boolean;
  readonly canMove: boolean;
  readonly onMove: (comment: PendingReviewComment) => void;
  readonly onCancel: () => void;
}) {
  if (comments.length === 0) return null;
  return (
    <div className="max-h-48 shrink-0 overflow-auto border-b px-4 py-2 text-xs">
      {moving ? (
        <div className="flex items-center justify-between gap-2">
          <span role="status">Select a current line to move this comment.</span>
          <Button size="xs" variant="ghost" onClick={onCancel}>
            Cancel move
          </Button>
        </div>
      ) : (
        <>
          <p className="text-muted-foreground">Line comments that need a new anchor</p>
          {comments.map((comment) => (
            <div key={comment.id} className="flex items-center justify-between gap-2">
              <span className="min-w-0 whitespace-pre-wrap break-words">
                {comment.path} · {comment.body}
              </span>
              <Button
                size="xs"
                variant="outline"
                disabled={!canMove}
                onClick={() => onMove(comment)}
              >
                Move comment
              </Button>
            </div>
          ))}
        </>
      )}
    </div>
  );
}
