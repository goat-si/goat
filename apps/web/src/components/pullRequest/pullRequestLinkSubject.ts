import {
  parsePullRequestAnchor,
  pullRequestAnchorMatchesUrl,
  pullRequestLinkCommit,
  resolvePullRequestReviewAnchor,
} from "@goat/shared/pullRequestAnchor";
import type { PullRequestActivity, PullRequestActor, PullRequestCommit } from "@goat/contracts";
import type { Nodes as MdastNodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { PullRequestTimelineEvent } from "./pullRequestDetail.logic";

export type PullRequestLinkSubject =
  | {
      readonly kind: "comment";
      readonly author: PullRequestActor | null;
      readonly createdAt: string;
      readonly reviewState: string | null;
      readonly excerpt: string | null;
    }
  | { readonly kind: "commit"; readonly commit: PullRequestCommit };

const LINK_EXCERPT_LENGTH = 280;

/** The words of a markdown body, without markup, HTML or images, for a short preview. */
function markdownExcerpt(body: string): string | null {
  const words: string[] = [];
  const visit = (node: MdastNodes) => {
    if (node.type === "text" || node.type === "inlineCode") words.push(node.value);
    if (node.type !== "code" && "children" in node) for (const child of node.children) visit(child);
  };
  visit(fromMarkdown(body));
  // GitHub's alert marker (`> [!NOTE]`) parses as text but reads as markup.
  const text = words
    .join(" ")
    .replace(/\[!(?:note|tip|important|warning|caution)\]/giu, "")
    .replace(/\s+/gu, " ")
    .trim();
  if (text === "") return null;
  return text.length > LINK_EXCERPT_LENGTH ? `${text.slice(0, LINK_EXCERPT_LENGTH - 1)}…` : text;
}

/** The comment or commit a pull request link names, for its hover card; null for the PR itself. */
export function pullRequestLinkSubject(
  url: string,
  activity: Pick<PullRequestActivity, "comments" | "reviewThreads" | "commits">,
): PullRequestLinkSubject | null {
  const oid = pullRequestLinkCommit(url)?.toLowerCase();
  if (oid !== undefined) {
    const commit = activity.commits.find((candidate) => candidate.oid.toLowerCase() === oid);
    return commit === undefined ? null : { kind: "commit", commit };
  }
  const location = parsePullRequestAnchor(url);
  if (location?.kind !== "timeline") return null;
  const anchor = resolvePullRequestReviewAnchor(
    location.anchor,
    activity.comments,
    activity.reviewThreads,
  );
  const comment = activity.comments.find((candidate) =>
    pullRequestAnchorMatchesUrl(anchor, candidate.url),
  );
  const threadComment = activity.reviewThreads
    .flatMap((thread) => thread.comments)
    .find((candidate) => pullRequestAnchorMatchesUrl(anchor, candidate.url));
  const found = comment ?? threadComment;
  if (found === undefined) return null;
  return {
    kind: "comment",
    author: found.author,
    createdAt: found.createdAt,
    reviewState: comment?.reviewState ?? null,
    excerpt: markdownExcerpt(found.body),
  };
}

/** Whether a link anchor names this event or a reply in its review thread. */
export function pullRequestTimelineEventMatches(
  event: PullRequestTimelineEvent,
  anchor: string,
): boolean {
  return [event, ...(event.thread?.replies ?? [])].some((item) =>
    pullRequestAnchorMatchesUrl(anchor, item.url),
  );
}
