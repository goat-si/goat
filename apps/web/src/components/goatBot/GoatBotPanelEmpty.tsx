import { Button } from "../ui/button";

/** A work panel tab with nothing in it: what is missing, then how it gets there. */
export function GoatBotPanelEmpty({
  title,
  next,
}: {
  readonly title: string;
  readonly next: string;
}) {
  return (
    <div className="space-y-0.5">
      <p className="font-medium text-foreground">{title}</p>
      <p className="text-muted-foreground">{next}</p>
    </div>
  );
}

/** A work panel read that failed; what the tab already knew stays below it. */
export function GoatBotPanelFailure({
  message,
  onRetry,
}: {
  readonly message: string;
  readonly onRetry?: (() => void) | undefined;
}) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p>{message}</p>
      {onRetry === undefined ? null : (
        <Button size="xs" variant="outline" onClick={onRetry}>
          Try again
        </Button>
      )}
    </div>
  );
}
