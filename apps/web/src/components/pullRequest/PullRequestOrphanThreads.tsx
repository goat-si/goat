import type { PullRequestReviewThread } from "@goat/contracts";
import type { ReactNode } from "react";
import { ChevronRightIcon } from "~/components/solar";
import { cn } from "~/lib/utils";
import { Collapsible, CollapsiblePanel, CollapsibleTrigger } from "../ui/collapsible";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function PullRequestOrphanThreads({
  threads,
  placedThreadIds,
  allPagesLoaded,
  open,
  onOpenChange,
  renderThreadCard,
}: {
  readonly threads: ReadonlyArray<PullRequestReviewThread>;
  readonly placedThreadIds: ReadonlySet<string>;
  readonly allPagesLoaded: boolean;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly renderThreadCard: (thread: PullRequestReviewThread) => ReactNode;
}) {
  const orphanThreads = threads.filter((thread) => !placedThreadIds.has(thread.id));
  if (orphanThreads.length === 0) return null;
  const orphanFiles = new Map<string, PullRequestReviewThread[]>();
  for (const thread of orphanThreads) {
    const existing = orphanFiles.get(thread.path);
    if (existing) existing.push(thread);
    else orphanFiles.set(thread.path, [thread]);
  }
  return (
    <div className="shrink-0 border-b border-border/60">
      <Collapsible open={open} onOpenChange={onOpenChange}>
        <h2>
          <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-4 py-2 text-left text-xs text-muted-foreground">
            <span>
              {allPagesLoaded
                ? "Conversations not on the current diff"
                : "Conversations not on the diff loaded so far"}
            </span>
            <ChevronRightIcon
              aria-hidden
              className={cn("size-3.5 transition-transform", open && "rotate-90")}
            />
            <span aria-hidden className="tabular-nums">
              {orphanThreads.length}
            </span>
            <span className="sr-only">
              {orphanThreads.length === 1
                ? "1 conversation"
                : `${orphanThreads.length} conversations`}
            </span>
          </CollapsibleTrigger>
        </h2>
        <CollapsiblePanel>
          <div className="max-h-64 space-y-3 overflow-auto px-4 pb-3">
            {[...orphanFiles].map(([path, threads]) => (
              <div key={path}>
                <Tooltip>
                  <TooltipTrigger
                    render={<p className="truncate px-3 text-xs text-muted-foreground">{path}</p>}
                  />
                  <TooltipPopup side="top">{path}</TooltipPopup>
                </Tooltip>
                <div className="mt-1 space-y-2">
                  {threads.map((thread) => (
                    <div key={thread.id}>
                      {thread.line === null ? null : (
                        <p className="px-3 text-xs text-muted-foreground">Line {thread.line}</p>
                      )}
                      {renderThreadCard(thread)}
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </CollapsiblePanel>
      </Collapsible>
    </div>
  );
}
