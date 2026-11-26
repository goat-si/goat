import {
  pullRequestListLines,
  resolveThreadPullRequestChains,
  visibleThreadPullRequests,
} from "@goat/client-runtime/thread-pull-requests";
import type { ThreadPullRequestLink } from "@goat/contracts";
import type { MouseEvent, ReactNode } from "react";
import { cn } from "../lib/utils";
import { PullRequestGlyph, type PullRequestGlyphIcon } from "./pullRequest/pullRequestIcons";
import { resolvePullRequestState } from "./pullRequest/pullRequestPresentation";
import { Button } from "./ui/button";

// Hover previews stay short: rendering hundreds of rows froze the page and
// filled the screen. The full list lives in the Linked items tab.
const LINKED_ITEMS_PREVIEW_LIMIT = 8;

function LinkedItemsOverflow({
  hidden,
  onShowAll,
}: {
  hidden: number;
  onShowAll?: (() => void) | undefined;
}) {
  if (hidden <= 0) return null;
  if (!onShowAll) {
    return <div className="px-1 pt-1 text-muted-foreground">+{hidden} more</div>;
  }
  return (
    <Button
      variant="ghost-muted"
      size="xs"
      className="mt-1 w-full justify-start"
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onShowAll();
      }}
    >
      +{hidden} more in Linked items
    </Button>
  );
}

export function ThreadPullRequestsMiniList({
  pullRequests,
  onOpenPullRequest,
  onShowAll,
}: {
  pullRequests: ReadonlyArray<ThreadPullRequestLink>;
  onOpenPullRequest?: (event: MouseEvent<HTMLAnchorElement>, url: string) => void;
  onShowAll?: (() => void) | undefined;
}) {
  const lines = pullRequestListLines(
    resolveThreadPullRequestChains(visibleThreadPullRequests(pullRequests)),
  );
  if (lines.length === 0) return null;
  return (
    <>
      <ul className="flex flex-col gap-1">
        {lines.slice(0, LINKED_ITEMS_PREVIEW_LIMIT).map((line) => {
          const snapshot = line.link.snapshot;
          const presentation =
            snapshot === null
              ? null
              : resolvePullRequestState({ state: snapshot.state, isDraft: snapshot.isDraft });
          return (
            <ThreadPullRequestMiniListItem
              key={`${line.link.host}/${line.link.repository}#${line.link.number}`}
              number={line.link.number}
              url={line.link.url}
              title={snapshot?.title ?? line.link.repository}
              presentation={presentation}
              depth={line.depth}
              onOpenPullRequest={onOpenPullRequest}
            >
              {line.stack ? (
                <span className="ml-auto shrink-0 pl-1 text-3xs">
                  {line.stack.kind === "native" ? "stack" : "chain"} · {line.stack.size}
                </span>
              ) : null}
            </ThreadPullRequestMiniListItem>
          );
        })}
      </ul>
      <LinkedItemsOverflow
        hidden={lines.length - LINKED_ITEMS_PREVIEW_LIMIT}
        onShowAll={onShowAll}
      />
    </>
  );
}

export function ThreadPullRequestMiniListItem({
  number,
  url,
  title,
  presentation,
  depth = 0,
  onOpenPullRequest,
  children,
}: {
  number: number;
  url: string;
  title: string;
  presentation: { readonly Icon: PullRequestGlyphIcon; readonly toneClassName: string } | null;
  depth?: number;
  onOpenPullRequest?: ((event: MouseEvent<HTMLAnchorElement>, url: string) => void) | undefined;
  children?: ReactNode;
}) {
  const Icon = presentation?.Icon ?? PullRequestGlyph.pullRequest;
  const content = (
    <>
      <Icon
        aria-hidden
        className={cn("size-3 shrink-0", presentation?.toneClassName ?? "stroke-muted-foreground")}
      />
      <span className="shrink-0 font-mono tabular-nums">#{number}</span>
      <span className="min-w-0 truncate text-foreground/75">{title}</span>
      {children}
    </>
  );
  return (
    <li style={{ paddingLeft: `${Math.min(depth, 3) * 0.75}rem` }}>
      {onOpenPullRequest ? (
        <a
          href={url}
          target="_blank"
          rel="noopener noreferrer"
          className="flex min-w-0 items-center gap-2 rounded-sm px-1 py-1 hover:bg-accent focus-visible:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => onOpenPullRequest(event, url)}
        >
          {content}
        </a>
      ) : (
        <div className="flex min-w-0 items-center gap-2">{content}</div>
      )}
    </li>
  );
}
