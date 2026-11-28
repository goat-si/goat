import { useState } from "react";

const STICKY_EDGE_TOLERANCE_PX = 1;

export function sectionCollapseAnchorScrollTop(input: {
  readonly scrollTop: number;
  readonly viewportTop: number;
  readonly sectionTop: number;
  readonly headingTop: number;
}): number | null {
  const sectionHasScrolledPastViewport = input.sectionTop < input.viewportTop;
  const headingIsPinned = input.headingTop <= input.viewportTop + STICKY_EDGE_TOLERANCE_PX;
  if (!sectionHasScrolledPastViewport || !headingIsPinned) return null;

  return Math.max(0, input.scrollTop + input.sectionTop - input.viewportTop);
}

export interface PullRequestSummaryViewState {
  readonly order: "newest" | "oldest";
  readonly shown: number;
  readonly scrollTop: number;
}

const DEFAULT_COMMENT_PAGE = 10;
// Session-only: switching right-panel tabs unmounts the Summary, which comes back as it was left.
const summaryViewByScopeKey = new Map<string, PullRequestSummaryViewState>();

function readPullRequestSummaryView(viewKey: string): PullRequestSummaryViewState | undefined {
  return summaryViewByScopeKey.get(viewKey);
}

function rememberPullRequestSummaryView(
  viewKey: string,
  patch: Partial<PullRequestSummaryViewState>,
): void {
  const view = summaryViewByScopeKey.get(viewKey) ?? {
    order: "newest",
    shown: DEFAULT_COMMENT_PAGE,
    scrollTop: 0,
  };
  summaryViewByScopeKey.set(viewKey, { ...view, ...patch });
}

export function usePullRequestSummaryView(viewKey: string, detailUrl: string) {
  const [shown, setShownState] = useState(() => ({
    url: detailUrl,
    count: readPullRequestSummaryView(viewKey)?.shown ?? DEFAULT_COMMENT_PAGE,
  }));
  const [commentOrder, setCommentOrderState] = useState(
    () => readPullRequestSummaryView(viewKey)?.order ?? "newest",
  );
  return {
    shownConversations: shown.url === detailUrl ? shown.count : DEFAULT_COMMENT_PAGE,
    setShown: (count: number) => {
      setShownState({ url: detailUrl, count });
      rememberPullRequestSummaryView(viewKey, { shown: count });
    },
    commentOrder,
    toggleCommentOrder: () => {
      const order = commentOrder === "newest" ? "oldest" : "newest";
      setCommentOrderState(order);
      rememberPullRequestSummaryView(viewKey, { order });
    },
    initialScrollTop: readPullRequestSummaryView(viewKey)?.scrollTop ?? 0,
    rememberScrollTop: (scrollTop: number) =>
      rememberPullRequestSummaryView(viewKey, { scrollTop }),
  };
}

// The Summary restores its scroll on remount; a header left expanded would condense over the
// restored position and its scroll compensation would move the view.
export const summaryCondensedByScopeKey = new Map<string, boolean>();
