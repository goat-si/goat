import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";

import { toReviewThreadPage } from "./gitHubPullRequestJson.ts";
import { through, withReviewDefaults } from "./gitHubPullRequestJsonTestFixtures.ts";
import { ReviewThreads } from "./pullRequestReviews.graphql.ts";

const decodeReviewThreadsJson = (raw: string) =>
  through(ReviewThreads.result, toReviewThreadPage)(withReviewDefaults(raw));
const threadsJson = (nodes: ReadonlyArray<Record<string, unknown>>): string =>
  JSON.stringify({
    data: {
      repository: {
        pullRequest: {
          reviewThreads: {
            totalCount: nodes.length,
            pageInfo: { hasNextPage: false, endCursor: null },
            nodes,
          },
        },
      },
    },
  });

describe("review comment review links", () => {
  it("names the review a thread comment was posted in, and nothing for a comment without one", () => {
    const result = decodeReviewThreadsJson(
      threadsJson([
        {
          id: "PRRT_c",
          isResolved: false,
          path: "apps/server/src/ws.ts",
          comments: {
            nodes: [
              // A deleted review leaves pullRequestReview null.
              { id: "t1", body: "fix this", createdAt: "2026-07-01T00:00:00Z" },
              {
                id: "t2",
                body: "fixed",
                createdAt: "2026-07-01T01:00:00Z",
                pullRequestReview: {
                  url: "https://github.com/acme/web/pull/1#pullrequestreview-9",
                },
              },
            ],
          },
        },
      ]),
    );
    expect(Result.isSuccess(result)).toBe(true);
    if (!Result.isSuccess(result)) return;
    // A reply-only review has no text of its own; its link finds it through the reply it posted.
    const comments = result.success.threads[0]?.thread.comments ?? [];
    expect(comments.map((comment) => comment.reviewUrl)).toEqual([
      undefined,
      "https://github.com/acme/web/pull/1#pullrequestreview-9",
    ]);
    expect(comments[0]).not.toHaveProperty("reviewUrl");
  });
});
