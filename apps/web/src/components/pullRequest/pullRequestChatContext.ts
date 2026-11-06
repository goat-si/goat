import type { Nodes as MdastNodes } from "mdast";
import { fromMarkdown } from "mdast-util-from-markdown";
import type { PullRequestReviewThread } from "@goat/contracts";
import { inferReviewCommentFenceLanguage, type ReviewCommentContext } from "~/reviewCommentContext";
import type { PullRequestFinding } from "./pullRequestDetail.logic";

/** Marker-only bodies are empty; otherwise retain text, including fenced HTML comments. */
export function visibleBody(body: string): string | null {
  return body.replace(/<!--[\s\S]*?-->/gu, "").trim().length === 0 ? null : body.trim();
}

/**
 * A body as it reads, for text sent to the agent under a length bound. A bot's HTML-comment
 * bookkeeping would otherwise use up the bound before the remark got any of it. Comments in code
 * are source the remark is showing, so they stay. Null for a body with no words.
 */
export function readableBody(raw: string): string | null {
  if (visibleBody(raw) === null) return null;
  const body = raw.replace(/\r\n?/gu, "\n");
  const cuts: Array<[number, number]> = [];
  const visit = (node: MdastNodes) => {
    if (node.type === "html" && node.position?.start.offset !== undefined) {
      cuts.push([node.position.start.offset, node.position.end.offset ?? body.length]);
    }
    if ("children" in node) for (const child of node.children) visit(child);
  };
  visit(fromMarkdown(body));
  let readable = "";
  let from = 0;
  for (const [start, end] of cuts) {
    readable += body.slice(from, start);
    // An HTML block can carry markup around its comment; only the comment itself is hidden.
    const html = body.slice(start, end).replace(/<!--[\s\S]*?(?:-->|$)/gu, "");
    // A line that was all comment is dropped rather than left as a blank one.
    const ownLine = /(?:^|\n)[ \t>]*$/u.test(readable) && /^[ \t]*(?:\n|$)/u.test(body.slice(end));
    if (ownLine && html.trim() === "") {
      readable = readable.replace(/[ \t>]*$/u, "");
      from = end + (/^[ \t]*\n/u.exec(body.slice(end))?.[0].length ?? 0);
    } else {
      readable += html;
      from = end;
    }
  }
  readable = (readable + body.slice(from)).trim();
  return readable === "" ? null : readable;
}

const FINDING_BODY_MAX_LENGTH = 1_000;

export function bounded(value: string): string {
  const trimmed = value.trim();
  return trimmed.length <= FINDING_BODY_MAX_LENGTH
    ? trimmed
    : `${trimmed.slice(0, FINDING_BODY_MAX_LENGTH - 3)}...`;
}

export function reviewThreadContext(
  thread: PullRequestReviewThread,
  pullRequestNumber: number,
): ReviewCommentContext {
  const lineIndex = Math.max(0, (thread.line ?? 1) - 1);
  return {
    id: `pull-request-finding:${thread.id}`,
    sectionId: `pull-request:${pullRequestNumber}`,
    sectionTitle: `PR #${pullRequestNumber} review`,
    filePath: thread.path,
    startIndex: lineIndex,
    endIndex: lineIndex,
    rangeLabel:
      thread.line === null ? "file" : `L${thread.line}${thread.side === "left" ? " (before)" : ""}`,
    // Strip bot bookkeeping comments before bounding finding text.
    text: bounded(
      thread.comments
        .flatMap((comment) => {
          const body = readableBody(comment.body);
          return body === null ? [] : [`${comment.author?.login ?? "ghost"}: ${body}`];
        })
        .join("\n"),
    ),
    diff: "",
    fenceLanguage: inferReviewCommentFenceLanguage(thread.path),
  };
}

/** A remark the reader can bring into the chat: a conversation on a line, or one comment. */
export type PullRequestChatSubject = Extract<PullRequestFinding, { kind: "thread" | "comment" }>;

/**
 * A remark or conversation brought into the chat to talk about, not to fix. Its id carries the
 * URL because host ids are only unique within a repository. Null when there are no words in it.
 */
export function buildPullRequestCommentContext(
  pullRequest: { readonly number: number; readonly url: string },
  subject: PullRequestChatSubject,
): ReviewCommentContext | null {
  const pullRequestNumber = pullRequest.number;
  if (subject.kind === "thread") {
    const context = reviewThreadContext(subject.thread, pullRequestNumber);
    return context.text === ""
      ? null
      : { ...context, id: `pr-comment:${pullRequest.url}:thread:${subject.thread.id}` };
  }
  const comment = subject.comment;
  const body = readableBody(comment.body);
  if (body === null) return null;
  const author = comment.author?.login ?? "ghost";
  return {
    id: `pr-comment:${pullRequest.url}:comment:${comment.id}`,
    sectionId: `pull-request:${pullRequestNumber}`,
    sectionTitle: `PR #${pullRequestNumber} conversation`,
    // The chip wears `filePath rangeLabel`: the file a remark names, or who wrote one that names none.
    filePath: comment.path ?? `@${author}`,
    startIndex: 0,
    endIndex: 0,
    rangeLabel: "comment",
    text: bounded(`${author}: ${body}`),
    diff: "",
    ...(comment.path === null
      ? {}
      : { fenceLanguage: inferReviewCommentFenceLanguage(comment.path) }),
  };
}
