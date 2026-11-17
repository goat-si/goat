import {
  parsePullRequestAnchor,
  pullRequestAnchorMatchesUrl,
  pullRequestDiffPathMatches,
  pullRequestLinkCommit,
  resolvePullRequestReviewAnchor,
  type PullRequestAnchor,
} from "@goat/shared/pullRequestAnchor";
import type { PullRequestActivity } from "@goat/contracts";
import type { ActivityFilter } from "./pullRequestActivityFilter";
import type { GuideDiffFocus } from "./guide/guideDiffFocus";

export type PullRequestSection = "overview" | "activity" | "guide";

/** The tab a pull request link opens on. */
export function linkedPullRequestSection(url: string | undefined): PullRequestSection {
  const kind = parsePullRequestAnchor(url)?.kind;
  return kind === "timeline" || kind === "commits" ? "activity" : "overview";
}

/** A comment link shows every comment, bots and resolved ones too; a commits link shows commits. */
export function linkedActivityFilter(
  url: string | undefined,
  current: ActivityFilter,
): ActivityFilter {
  const kind = parsePullRequestAnchor(url)?.kind;
  if (kind === "timeline") return { ...current, kind: "all", bots: true, resolved: true };
  if (kind === "commits") return { ...current, kind: "commits" };
  return current;
}

/** The activity row a comment link names: a thread opens its discussion, a comment its row. */
export function activityLinkTarget(
  url: string | undefined,
  activity: Pick<PullRequestActivity, "comments" | "reviewThreads"> | null | undefined,
) {
  const location = parsePullRequestAnchor(url);
  if (location?.kind !== "timeline") return { targetKey: null, targetThread: null };
  const anchor = activity
    ? resolvePullRequestReviewAnchor(location.anchor, activity.comments, activity.reviewThreads)
    : location.anchor;
  const targetThread =
    activity?.reviewThreads.find((thread) =>
      thread.comments.some((comment) => pullRequestAnchorMatchesUrl(anchor, comment.url)),
    ) ?? null;
  const targetComment = activity?.comments.find((comment) =>
    pullRequestAnchorMatchesUrl(anchor, comment.url),
  );
  const targetKey = targetThread
    ? `discussion:${targetThread.id}`
    : targetComment
      ? `comment:${targetComment.id}`
      : null;
  return { targetKey, targetThread };
}

/**
 * The file a diff link names. Other screens open files with the link's params spread in, so only
 * the link's own entry (no path, the link's commit) follows it.
 */
export function fileRouteLink(
  params: { readonly path: string; readonly commit?: string; readonly navigationUrl?: string },
  files: ReadonlyArray<{ readonly path: string }> | null,
): { readonly anchor: PullRequestAnchor | null; readonly path: string | undefined } {
  const anchor =
    params.path === "" && (params.commit ?? null) === pullRequestLinkCommit(params.navigationUrl)
      ? parsePullRequestAnchor(params.navigationUrl)
      : null;
  const path =
    anchor?.kind === "diff"
      ? files?.find((file) => pullRequestDiffPathMatches(anchor.digest, file.path))?.path
      : undefined;
  return { anchor, path };
}

/** The lines a diff link names, as the focus the diff view highlights. */
export function linkedDiffFocus(anchor: PullRequestAnchor | null): GuideDiffFocus | undefined {
  const range = anchor?.kind === "diff" ? anchor.range : null;
  if (!range) return undefined;
  return {
    side: range.side === "left" ? "old" : "new",
    start: range.start,
    end: range.end,
    endSide: range.endSide === "left" ? "old" : "new",
  };
}
