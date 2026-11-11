import { describe, expect, it } from "vite-plus/test";
import type { PullRequestComment } from "@goat/contracts";
import { reviewCommentContextLabel } from "~/lib/composerContextRecords";
import {
  appendHandoff,
  buildAskAboutPullRequestHandoff,
  buildPullRequestCommentContext,
} from "./pullRequestDetail.logic";
import { bounded } from "./pullRequestChatContext";

describe("bounding review text", () => {
  it("does not split a surrogate pair at the cut", () => {
    // The emoji starts exactly at the cut, so its halves straddle it.
    expect(bounded(`${"x".repeat(996)}😀 and more of the review.`)).toBe(`${"x".repeat(996)}...`);
  });
});

describe("adding a remark to the chat", () => {
  const pullRequest = { number: 42, url: "https://github.com/goat-si/goat/pull/42" };
  const remark = (id: string, body: string): PullRequestComment => ({
    id,
    kind: "issue-comment",
    author: { login: "octocat", name: null, avatarUrl: null },
    body,
    createdAt: "2026-07-03T00:00:00Z",
    url: null,
    path: null,
    reviewState: null,
  });

  it("reads as the remark's author rather than as the pull request itself", () => {
    const context = buildPullRequestCommentContext(pullRequest, {
      kind: "comment",
      comment: remark("c1", "Why not reuse the existing parser?"),
    });

    expect(context && reviewCommentContextLabel(context)).toBe("#42 @octocat comment");
    expect(context?.text).toBe("octocat: Why not reuse the existing parser?");
  });

  it("keeps every added remark when a later hand-off lands", () => {
    const added = ["c1", "c2"].flatMap(
      (id) =>
        buildPullRequestCommentContext(pullRequest, {
          kind: "comment",
          comment: remark(id, "why?"),
        }) ?? [],
    );
    const handedOff = buildAskAboutPullRequestHandoff({
      number: 42,
      title: "Add the pull requests page",
      url: "https://github.com/goat-si/goat/pull/42",
      headBranch: "feature",
      baseBranch: "main",
      state: "open",
      isDraft: false,
    });

    expect(
      appendHandoff({ prompt: "", reviewComments: added }, handedOff).reviewComments.map(
        (comment) => comment.id,
      ),
    ).toEqual([
      "pr-comment:https://github.com/goat-si/goat/pull/42:comment:c1",
      "pr-comment:https://github.com/goat-si/goat/pull/42:comment:c2",
      "pull-request-context:https://github.com/goat-si/goat/pull/42",
    ]);
  });

  it("drops a bot's bookkeeping so it cannot crowd the remark out of the bound", () => {
    const context = buildPullRequestCommentContext(pullRequest, {
      kind: "comment",
      comment: remark(
        "c1",
        `<!-- ${"state".repeat(400)} -->\nThis leaks the token.\n\n\`\`\`html\n<!-- kept -->\n\`\`\``,
      ),
    });

    expect(context?.text).toBe("octocat: This leaks the token.\n\n```html\n<!-- kept -->\n```");
  });

  it("keeps comments inside a quoted fence as code", () => {
    const context = buildPullRequestCommentContext(pullRequest, {
      kind: "comment",
      comment: remark("c1", "> ```html\n> <!-- open\n> ```\n> Quoted. <!-- bot -->\nMine."),
    });

    expect(context?.text).toBe("octocat: > ```html\n> <!-- open\n> ```\n> Quoted. \nMine.");
  });

  it("holds a fence open over a deeper quoted fence and closes it with its blockquote", () => {
    const nested = buildPullRequestCommentContext(pullRequest, {
      kind: "comment",
      comment: remark("c1", "```md\n> ```\n<!-- kept -->\n```\nMine. <!-- bot -->"),
    });
    const unquoted = buildPullRequestCommentContext(pullRequest, {
      kind: "comment",
      comment: remark("c2", "> ```\n> code\nMine. <!-- bot -->"),
    });

    expect(nested?.text).toBe("octocat: ```md\n> ```\n<!-- kept -->\n```\nMine.");
    expect(unquoted?.text).toBe("octocat: > ```\n> code\nMine.");
  });

  it("keeps a fence written inside a hidden comment hidden", () => {
    const context = buildPullRequestCommentContext(pullRequest, {
      kind: "comment",
      comment: remark("c1", '<!-- state\n```json\n{"secret": 1}\n```\n-->\nLooks good.'),
    });

    expect(context?.text).toBe("octocat: Looks good.");
  });

  it("closes a fence written with CRLF line endings", () => {
    const context = buildPullRequestCommentContext(pullRequest, {
      kind: "comment",
      comment: remark("c1", "```ts\r\nconst x = 1;\r\n```\r\n<!-- bot -->\r\nRename x."),
    });

    expect(context?.text).toBe("octocat: ```ts\nconst x = 1;\n```\nRename x.");
  });

  it("reads inline code at the start of a line as prose, not as a fence", () => {
    const context = buildPullRequestCommentContext(pullRequest, {
      kind: "comment",
      comment: remark("c1", "```x``` is unused <!-- bot -->\nRemove it."),
    });

    expect(context?.text).toBe("octocat: ```x``` is unused \nRemove it.");
  });

  it("keeps remarks from two repositories apart when their host ids match", () => {
    const other = { number: 42, url: "https://github.com/octocat/fork/pull/42" };
    const ids = [pullRequest, other].map(
      (target) =>
        buildPullRequestCommentContext(target, { kind: "comment", comment: remark("c1", "why?") })
          ?.id,
    );

    expect(new Set(ids).size).toBe(2);
  });

  it("brings nothing for a remark an unfinished comment hides", () => {
    expect(
      buildPullRequestCommentContext(pullRequest, {
        kind: "comment",
        comment: remark("c1", "<!-- bot state left open"),
      }),
    ).toBeNull();
  });

  it("brings nothing for a remark with no words in it", () => {
    expect(
      buildPullRequestCommentContext(pullRequest, {
        kind: "comment",
        comment: remark("c1", "<!-- bot bookkeeping -->"),
      }),
    ).toBeNull();
  });

  it("brings nothing for a conversation with no words in it", () => {
    const {
      kind: _kind,
      path: _path,
      reviewState: _reviewState,
      ...bookkeeping
    } = remark("tc1", "<!-- bot bookkeeping -->");
    expect(
      buildPullRequestCommentContext(pullRequest, {
        kind: "thread",
        thread: {
          id: "t1",
          path: "src/app.ts",
          line: 3,
          side: "right",
          isResolved: false,
          isOutdated: false,
          comments: [bookkeeping],
        },
      }),
    ).toBeNull();
  });
});
