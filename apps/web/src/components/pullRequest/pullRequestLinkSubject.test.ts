import type { PullRequestActivity } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { pullRequestLinkSubject } from "./pullRequestLinkSubject";

const pr = "https://github.com/o/r/pull/1";
const sha = "a".repeat(40);
const author = { login: "author", name: null, avatarUrl: null };
const activity: Pick<PullRequestActivity, "comments" | "reviewThreads" | "commits"> = {
  comments: [
    {
      id: "c1",
      kind: "issue-comment",
      author,
      body: "<!-- bot -->\n> [!NOTE]\n> **Looks** good, see `run()` ![shot](x.png)",
      createdAt: "2026-07-02T00:00:00Z",
      url: `${pr}#issuecomment-5`,
      path: null,
      reviewState: null,
    },
  ],
  reviewThreads: [
    {
      id: "t",
      path: "a.ts",
      line: 1,
      side: "right",
      isResolved: false,
      isOutdated: false,
      comments: [
        {
          id: "r1",
          author: { login: "reviewer", name: null, avatarUrl: null },
          body: "nit",
          createdAt: "2026-07-03T00:00:00Z",
          url: `${pr}#discussion_r1`,
          reviewUrl: `${pr}#pullrequestreview-9`,
        },
      ],
    },
  ],
  commits: [{ oid: sha, messageHeadline: "fix it", committedDate: "2026-07-02T00:00:00Z" }],
};

describe("pullRequestLinkSubject", () => {
  it("names the comment or commit a link points at for its hover card", () => {
    expect(pullRequestLinkSubject(`${pr}#issuecomment-5`, activity)).toMatchObject({
      kind: "comment",
      excerpt: "Looks good, see run()",
    });
    for (const [body, excerpt] of [
      ["Keep `[!NOTE]` in the file.", "Keep [!NOTE] in the file."],
      ["> [!NOTE]\n> Real alert.", "Real alert."],
      ["Keep [!WARNING] in prose.", "Keep [!WARNING] in prose."],
    ] as const) {
      expect(
        pullRequestLinkSubject(`${pr}#issuecomment-5`, {
          comments: [{ ...activity.comments[0]!, body }],
          reviewThreads: [],
          commits: [],
        }),
        body,
      ).toMatchObject({ kind: "comment", excerpt });
    }
    // A review with no text of its own is shown through the comment it posted.
    expect(pullRequestLinkSubject(`${pr}#pullrequestreview-9`, activity)).toMatchObject({
      kind: "comment",
      author: { login: "reviewer" },
      excerpt: "nit",
    });
    expect(pullRequestLinkSubject(`${pr}/commits/${sha}`, activity)).toMatchObject({
      kind: "commit",
      commit: { messageHeadline: "fix it" },
    });
    for (const url of [pr, `${pr}/files`, `${pr}/checks`, `${pr}#issuecomment-6`]) {
      expect(pullRequestLinkSubject(url, activity), url).toBeNull();
    }
    // An emoji straddling the cut is dropped whole rather than split into a lone surrogate.
    const [comment] = activity.comments;
    const long = comment
      ? { ...activity, comments: [{ ...comment, body: `${"i ".repeat(139)}😀bb` }] }
      : activity;
    const cut = pullRequestLinkSubject(`${pr}#issuecomment-5`, long);
    const excerpt = cut && "excerpt" in cut ? cut.excerpt : null;
    expect(excerpt).toMatch(/^(?:i ?)+…$/u);
  });
});
