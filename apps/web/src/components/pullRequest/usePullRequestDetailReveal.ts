import type { PullRequestDetailView } from "@goat/contracts";
import {
  pullRequestLinkCommit,
  resolvePullRequestReviewAnchor,
  type PullRequestAnchor,
} from "@goat/shared/pullRequestAnchor";
import { useEffect, useEffectEvent, useRef } from "react";
import type { PullRequestDetailTab } from "~/rightPanelStore";

import { buildPullRequestTimeline } from "./pullRequestDetail.logic";
import { pullRequestTimelineEventMatches } from "./pullRequestLinkSubject";

/** The detail tab a pull request link opens; null when the link names nothing in the panel. */
export function linkedTab(anchor: PullRequestAnchor | null): PullRequestDetailTab | null {
  switch (anchor?.kind) {
    case "code":
    case "diff":
      return "code";
    case "commits":
    case "timeline":
      return "timeline";
    case "checks":
    case "summary":
      return "summary";
    default:
      return null;
  }
}

/**
 * Follows a clicked link into the panel: selects its tab and commit, and settles a link to a
 * comment the loaded activity lacks only after one fresh host read. Returns the settle callback
 * the tabs report a shown or missing link through.
 */
export function usePullRequestDetailReveal(input: {
  readonly revealUrl: string | undefined;
  readonly revealAnchor: PullRequestAnchor | null;
  readonly onRevealSettled: ((revealUrl: string) => void) | undefined;
  readonly detail: PullRequestDetailView | null;
  readonly activity: {
    readonly isPending: boolean;
    readonly error: unknown;
    readonly dataUpdatedAt: number;
  };
  readonly selectTab: (tab: PullRequestDetailTab) => void;
  readonly selectCodeCommit: (oid: string | null) => void;
  readonly loadCodeTab: () => void;
  /** Resolves whether the host cache was invalidated before the refetch. */
  readonly refetchFromHost: () => Promise<boolean>;
}): (revealUrl: string) => void {
  const { revealUrl, revealAnchor, detail, activity } = input;
  // Cached activity can predate a linked comment, so a miss waits for one host read. `after` is
  // when that read's invalidation finished; null while it runs.
  const revealHostRead = useRef<{ readonly url: string; readonly after: number | null } | null>(
    null,
  );
  const settleReveal = (url: string) => {
    revealHostRead.current = null;
    input.onRevealSettled?.(url);
  };
  const followLink = useEffectEvent(() => {
    if (revealUrl === undefined) return;
    const next = linkedTab(revealAnchor);
    if (next === null) return settleReveal(revealUrl);
    if (next === "code") {
      input.selectCodeCommit(pullRequestLinkCommit(revealUrl));
      input.loadCodeTab();
    }
    input.selectTab(next);
    // These name a tab, not a place in it.
    if (revealAnchor?.kind === "code" || revealAnchor?.kind === "commits") settleReveal(revealUrl);
  });
  // oxlint-disable-next-line goat/react-effect-budget -- a clicked link lives in the panel store and selects its tab even when the panel is already mounted
  useEffect(() => {
    followLink();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- each clicked link is a navigation request
  }, [revealUrl]);

  const timelineAnchor =
    revealAnchor?.kind !== "timeline"
      ? null
      : detail === null
        ? revealAnchor.anchor
        : resolvePullRequestReviewAnchor(
            revealAnchor.anchor,
            detail.comments,
            detail.reviewThreads,
          );
  // Loaded activity without the linked item, keyed by load so a refetch is checked again.
  const revealMissedAt =
    timelineAnchor !== null &&
    detail !== null &&
    !activity.isPending &&
    !buildPullRequestTimeline(detail).some((event) =>
      pullRequestTimelineEventMatches(event, timelineAnchor),
    )
      ? activity.dataUpdatedAt
      : null;
  const revealReadFailed = revealMissedAt !== null && activity.error !== null;
  const readHostForReveal = useEffectEvent(() => {
    if (revealUrl === undefined || revealMissedAt === null) return;
    const read = revealHostRead.current;
    if (read?.url !== revealUrl) {
      const request = { url: revealUrl, after: null };
      revealHostRead.current = request;
      void input.refetchFromHost().then((invalidated) => {
        if (revealHostRead.current !== request) return;
        // Without an invalidation the refetch could only repeat the cached read.
        if (!invalidated) return settleReveal(request.url);
        revealHostRead.current = { url: request.url, after: Date.now() };
      });
      return;
    }
    // A read that finished before the invalidation cannot show the item is missing. `after` is
    // stamped once the refetch was requested, so a read in that same millisecond is the new one.
    if (read.after !== null && (revealReadFailed || revealMissedAt >= read.after)) {
      settleReveal(revealUrl);
    }
  });
  // oxlint-disable-next-line goat/react-effect-budget -- a linked comment missing from cached activity asks the host once before the link settles
  useEffect(() => {
    readHostForReveal();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- each load that misses the linked item is checked against the host read
  }, [revealMissedAt, revealReadFailed, revealUrl]);
  // oxlint-disable-next-line goat/react-effect-budget -- a host read outliving the panel must not settle a later link
  useEffect(
    () => () => {
      revealHostRead.current = null;
    },
    [],
  );
  return settleReveal;
}
