import { goatBotRowPullRequests } from "@goat/client-runtime/goatBot";
import { cn } from "~/lib/utils";
import { PULL_REQUEST_STATE_PRESENTATION, PullRequestGlyph } from "../pullRequest/pullRequestIcons";

/** At most this many chips sit on a work row; the rest are counted. */
const VISIBLE_PULL_REQUESTS = 2;

/**
 * A work row's pull requests as text inside the row's own control. Each chip's sighted parts are
 * hidden from screen readers, which hear its full name on the control instead.
 */
export function GoatBotPullRequestChips(props: {
  readonly row: Parameters<typeof goatBotRowPullRequests>[0];
}) {
  const { chips, more, moreLabel } = goatBotRowPullRequests(props.row, VISIBLE_PULL_REQUESTS);
  if (chips.length === 0 && moreLabel === null) return null;
  return (
    // Wraps instead of clipping, so a narrow row never cuts a chip or the count in half.
    <span className="mt-0.5 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs">
      {chips.map((chip) => {
        const presentation =
          chip.state === "unknown" ? null : PULL_REQUEST_STATE_PRESENTATION[chip.state];
        const Icon = presentation?.Icon ?? PullRequestGlyph.pullRequest;
        // Only the repository gives way to a narrow row; the number and the state stay whole.
        const number = `#${chip.number}`;
        const repository = chip.text.slice(0, chip.text.length - number.length);
        return (
          <span
            key={chip.key}
            className={cn(
              "inline-flex max-w-full min-w-0 items-center gap-1",
              presentation?.toneClassName ?? "text-muted-foreground",
            )}
          >
            <Icon aria-hidden className="size-3.5 shrink-0" />
            <span aria-hidden className="flex min-w-0">
              {repository === "" ? null : <span className="truncate">{repository}</span>}
              <span className="shrink-0">{number}</span>
            </span>
            {presentation === null ? null : (
              <span aria-hidden className="shrink-0">
                {presentation.label}
              </span>
            )}
            <span className="sr-only">{chip.accessibleName}</span>
          </span>
        );
      })}
      {moreLabel === null ? null : (
        <span className="shrink-0 text-muted-foreground">
          <span aria-hidden>{moreLabel}</span>
          <span className="sr-only">
            {more === 1 ? "1 more pull request" : `${more} more pull requests`}
          </span>
        </span>
      )}
    </span>
  );
}
