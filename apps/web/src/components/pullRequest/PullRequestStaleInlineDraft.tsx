import { Button } from "../ui/button";

export function PullRequestStaleInlineDraft({
  text,
  reanchoring,
  canReanchor,
  onReanchor,
  onDiscard,
}: {
  readonly text: string;
  readonly reanchoring: boolean;
  readonly canReanchor: boolean;
  readonly onReanchor: () => void;
  readonly onDiscard: () => void;
}) {
  return (
    <section aria-label="Stale inline draft" className="shrink-0 border-b px-4 py-2 text-xs">
      <p role="status" className="text-muted-foreground">
        {reanchoring
          ? "Select a current line for this draft."
          : "The diff changed while you were writing. Re-anchor your draft to continue."}
      </p>
      <p className="my-2 max-h-24 overflow-auto whitespace-pre-wrap break-words">{text}</p>
      <div className="flex gap-2">
        {!reanchoring ? (
          <Button size="xs" variant="outline" disabled={!canReanchor} onClick={onReanchor}>
            Re-anchor draft
          </Button>
        ) : null}
        <Button size="xs" variant="ghost" onClick={onDiscard}>
          Discard draft
        </Button>
      </div>
    </section>
  );
}
