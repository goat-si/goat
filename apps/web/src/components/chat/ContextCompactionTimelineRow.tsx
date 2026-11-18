import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { ArrowRightIcon, CircleAlertIcon, MinimizeIcon as Minimize2Icon } from "~/components/solar";
import { cn } from "~/lib/utils";
import type { TimelineRow } from "./timelineRowContext";
import { ActivityShimmerOverlay } from "./TimelineRowParts";

export function ContextCompactionTimelineRow({
  row,
}: {
  row: Extract<TimelineRow, { kind: "context-compaction" }>;
}) {
  const label =
    row.title && row.label.startsWith("Context compacted")
      ? row.title + row.label.slice("Context compacted".length)
      : row.label;
  const content = (
    <span className="flex min-w-0 items-center gap-1.5">
      {row.failed ? (
        <CircleAlertIcon aria-hidden="true" className="size-3 shrink-0" />
      ) : (
        <Minimize2Icon aria-hidden="true" className="size-3" />
      )}
      {row.tokenCounts ? (
        <>
          {row.title ?? "Context compacted"} {row.tokenCounts.before}
          <ArrowRightIcon aria-hidden="true" className="size-3" />
          {row.tokenCounts.after} tokens
        </>
      ) : (
        label
      )}
      {row.failure ? (
        <span className="min-w-0 truncate opacity-80">&middot; {row.failure}</span>
      ) : null}
    </span>
  );
  return (
    <div
      role="separator"
      aria-label={row.failure ? `${label}: ${row.failure}` : label}
      className={cn(
        "mx-auto flex w-full max-w-(--chat-content-max-width) items-center gap-3 py-1 text-xs",
        row.failed ? "text-destructive" : "text-muted-foreground",
      )}
    >
      <span className={cn("h-px flex-1", row.failed ? "bg-destructive/30" : "bg-border/70")} />
      <span
        ref={row.active ? observeVisibleAnimation : undefined}
        className="relative min-w-0 overflow-hidden"
      >
        {content}
        {row.active ? <ActivityShimmerOverlay>{content}</ActivityShimmerOverlay> : null}
      </span>
      <span className={cn("h-px flex-1", row.failed ? "bg-destructive/30" : "bg-border/70")} />
    </div>
  );
}
