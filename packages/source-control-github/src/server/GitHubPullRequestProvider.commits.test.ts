import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { PullRequestReaction } from "@goat/contracts";
import * as GitHubPullRequestApi from "./GitHubPullRequestApi.ts";
import { make } from "./GitHubPullRequestProvider.ts";
import type { GitHubReviewThreadComments } from "./gitHubPullRequestJson.ts";

describe("getChangeRequest commits", () => {
  const baseDetail = {
    authorId: null,
    number: 7,
    title: "Pull request 7",
    url: "https://github.com/acme/web/pull/7",
    author: null,
    headBranch: "feat/page",
    baseBranch: "main",
    state: "open" as const,
    isDraft: false,
    mergeability: "mergeable" as const,
    additions: 1,
    deletions: 1,
    createdAt: "2026-07-01T00:00:00Z",
    updatedAt: "2026-07-02T00:00:00Z",
    reviewRequestLogins: [],
    hasTeamReviewRequest: false,
    checksState: null,
    labels: [],
    body: "",
    changedFiles: 1,
    mergedAt: null,
    closedAt: null,
    checks: [],
    comments: [],
  };

  const baseThreadComments = {
    comments: [],
    dismissalsByReviewId: new Map<string, string>(),
    reviewThreads: [],
    commentCount: 0,
    truncated: false,
    reviewThreadsTruncated: false,
    reactions: [],
    reactionsById: new Map<string, ReadonlyArray<PullRequestReaction>>(),
    editedAtById: new Map<string, string>(),
    reviewers: [],
    avatarsByLogin: new Map<string, string>(),
    botLogins: new Set<string>(),
    viewer: { canUpdate: true, didAuthor: false },
  };

  const layerWith = (commits: GitHubReviewThreadComments["commits"]) =>
    Layer.mock(GitHubPullRequestApi.GitHubPullRequestApi)({
      revalidateChecks: (_input, read) => read,
      getPullRequestActivity: () =>
        Effect.succeed({
          author: baseDetail.author,
          comments: baseDetail.comments,
          commits: [
            {
              oid: "graphql-newest",
              messageHeadline: "Activity metadata",
              committedDate: "2026-07-06T00:00:00Z",
              additions: 18,
              deletions: 7,
              authors: [],
            },
            {
              oid: "view-oldest",
              messageHeadline: "gh pr view's oldest commit",
              committedDate: "2026-01-01T00:00:00Z",
              authors: [],
            },
          ],
        }),
      listReviewThreadComments: () => Effect.succeed({ ...baseThreadComments, commits }),
    });

  it.effect("prefers the GraphQL commits, which are the newest, over the gh view list", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const detail = yield* provider.getChangeRequestActivity({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(detail.commits.map((commit) => commit.oid)).toEqual(["graphql-newest"]);
      expect(detail.commits[0]).toMatchObject({
        messageHeadline: "the newest commit gh pr view drops",
        additions: 18,
        deletions: 7,
      });
    }).pipe(
      Effect.provide(
        layerWith([
          {
            oid: "graphql-newest",
            messageHeadline: "the newest commit gh pr view drops",
            committedDate: "2026-07-06T00:00:00Z",
            authors: [],
          },
        ]),
      ),
    ),
  );

  it.effect("falls back to the gh view list when the GraphQL read has no commits", () =>
    Effect.gen(function* () {
      const provider = yield* make;
      const detail = yield* provider.getChangeRequestActivity({
        cwd: "/w",
        repository: "acme/web",
        host: "github.com",
        number: 7,
      });

      expect(detail.commits.map((commit) => commit.oid)).toEqual(["graphql-newest", "view-oldest"]);
    }).pipe(Effect.provide(layerWith([]))),
  );
});
