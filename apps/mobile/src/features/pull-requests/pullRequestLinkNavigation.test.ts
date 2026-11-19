import type { PullRequestActivity } from "@goat/contracts";
import { describe, expect, it } from "vite-plus/test";

import { DEFAULT_ACTIVITY_FILTER } from "./pullRequestActivityFilter";
import {
  activityLinkTarget,
  fileRouteLink,
  linkedActivityFilter,
  linkedDiffFocus,
  linkedPullRequestSection,
} from "./pullRequestLinkNavigation";

const pr = "https://github.com/org/repo/pull/12";
const author = { login: "a", name: null, avatarUrl: null };

describe("native pull request links", () => {
  it("opens the section a link names, with every comment shown for a comment link", () => {
    expect(linkedPullRequestSection(`${pr}#issuecomment-5`)).toBe("activity");
    expect(linkedPullRequestSection(`${pr}/commits`)).toBe("activity");
    expect(linkedPullRequestSection(`${pr}/checks`)).toBe("overview");
    expect(linkedPullRequestSection(undefined)).toBe("overview");
    expect(linkedActivityFilter(`${pr}#issuecomment-5`, DEFAULT_ACTIVITY_FILTER)).toEqual({
      ...DEFAULT_ACTIVITY_FILTER,
      bots: true,
      resolved: true,
    });
    expect(linkedActivityFilter(`${pr}/commits`, DEFAULT_ACTIVITY_FILTER).kind).toBe("commits");
    expect(linkedActivityFilter(pr, DEFAULT_ACTIVITY_FILTER)).toBe(DEFAULT_ACTIVITY_FILTER);
  });

  it("targets the thread a linked reply sits in, or the linked comment's own row", () => {
    const activity: Pick<PullRequestActivity, "comments" | "reviewThreads"> = {
      comments: [
        {
          id: "c1",
          kind: "issue-comment",
          author,
          body: "hi",
          createdAt: "2026-07-01T00:00:00Z",
          url: `${pr}#issuecomment-5`,
          path: null,
          reviewState: null,
        },
      ],
      reviewThreads: [
        {
          id: "t1",
          path: "a.ts",
          line: 1,
          side: "right",
          isResolved: true,
          isOutdated: false,
          comments: [
            {
              id: "r1",
              author,
              body: "nit",
              createdAt: "2026-07-01T00:00:00Z",
              url: `${pr}#discussion_r7`,
            },
          ],
        },
      ],
    };
    expect(activityLinkTarget(`${pr}#issuecomment-5`, activity)).toEqual({
      targetKey: "comment:c1",
      targetThread: null,
    });
    expect(activityLinkTarget(`${pr}#discussion_r7`, activity)).toMatchObject({
      targetKey: "discussion:t1",
      targetThread: { id: "t1" },
    });
    // A comment the loaded activity lacks, or no activity yet, targets nothing.
    expect(activityLinkTarget(`${pr}#issuecomment-6`, activity).targetKey).toBeNull();
    expect(activityLinkTarget(`${pr}#issuecomment-5`, null).targetKey).toBeNull();
  });

  it("follows a diff link only on its own entry, to the file and lines it names", () => {
    // SHA-256 of "src/b.ts", as GitHub names a file in a diff link.
    const digest = "363f5941f4d8df68d4bd5a6a9fa72f57f452e7ea9880d3a622cdaae065f1b5fb";
    const url = `${pr}/files#diff-${digest}L3-R5`;
    const files = [{ path: "src/a.ts" }, { path: "src/b.ts" }];
    const link = fileRouteLink({ path: "", navigationUrl: url }, files);
    expect(link.path).toBe("src/b.ts");
    expect(linkedDiffFocus(link.anchor)).toEqual({ side: "old", start: 3, end: 5, endSide: "new" });
    // Another screen opening a file with the link's params spread in keeps its own file.
    expect(fileRouteLink({ path: "src/a.ts", navigationUrl: url }, files)).toEqual({
      anchor: null,
      path: undefined,
    });
    // Files not loaded yet name no path, so the screen keeps paging.
    expect(fileRouteLink({ path: "", navigationUrl: url }, null).path).toBeUndefined();
  });
});
