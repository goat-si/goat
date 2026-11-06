import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import { make } from "./GitLabPullRequestProvider.ts";

describe("optional activity reads", () => {
  const reference = { cwd: "/w", repository: "acme/web", host: "gitlab.com", number: 7 };
  const comment = {
    id: "42",
    kind: "issue-comment" as const,
    author: null,
    body: "Keep this comment",
    createdAt: "2026-07-01T00:00:00Z",
    url: null,
    path: null,
    reviewState: null,
  };
  const commit = {
    oid: "abc",
    messageHeadline: "Keep this commit",
    committedDate: "2026-07-01T00:00:00Z",
  };
  const webUrl = "https://git.acme.dev/acme/web/-/merge_requests/7";
  const currentRefs = { baseSha: "base2", startSha: "start2", headSha: "head2" };
  const reads = {
    getMergeRequestDetail: () =>
      Effect.succeed({
        number: 7,
        title: "Merge request 7",
        url: webUrl,
        author: null,
        headBranch: "feat/page",
        baseBranch: "main",
        state: "open" as const,
        isDraft: false,
        mergeability: "mergeable" as const,
        additions: 0,
        deletions: 0,
        createdAt: "2026-07-01T00:00:00Z",
        updatedAt: "2026-07-02T00:00:00Z",
        reviewRequestLogins: [],
        labels: [],
        body: "",
        changedFiles: 1,
        mergedAt: null,
        closedAt: null,
        reviewers: [],
        checks: [],
        viewerCanMerge: true,
        reviewerIds: [],
        diffRefs: currentRefs,
      }),
    listNotes: () => Effect.succeed({ comments: [comment], truncated: false }),
    listCommits: () => Effect.succeed([commit]),
    listDiscussions: () =>
      Effect.succeed({
        threads: [],
        diffRefsByThreadId: new Map(),
        overviewFindingIds: [],
        truncated: false,
      }),
    listReactions: () =>
      Effect.succeed({
        reactions: [],
        reactionsByNoteId: new Map(),
        editedAtByNoteId: new Map(),
        botLogins: new Set<string>(),
      }),
  };
  const context = {
    operation: "execute" as const,
    command: "glab" as const,
    cwd: "/w",
    cause: null,
  };

  it.effect.each([
    {
      operation: "listNotes",
      error: new GitLabCli.GitLabCliAuthenticationError(context),
      reason: "unauthenticated",
    },
    {
      operation: "listCommits",
      error: new GitLabCli.GitLabCliUnavailableError(context),
      reason: "missing-tool",
    },
  ] as const)(
    "reports $reason instead of successful partial activity",
    ({ operation, error, reason }) =>
      Effect.gen(function* () {
        const provider = yield* make.pipe(
          Effect.provide(
            Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
              ...reads,
              [operation]: () => Effect.fail(error),
            }),
          ),
        );

        expect(yield* Effect.result(provider.getChangeRequestActivity(reference))).toMatchObject({
          _tag: "Failure",
          failure: {
            _tag: "PullRequestProviderError",
            provider: "gitlab",
            operation: "getChangeRequestActivity",
            reason,
            detail: error.detail,
            cause: error,
          },
        });
      }),
  );

  it.effect("turns the first note of an open overview discussion into a review finding", () =>
    Effect.gen(function* () {
      const finding = { ...comment, id: "10", body: "Mention the flag in the README" };
      const reply = { ...comment, id: "11", body: "Will do" };
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            ...reads,
            listNotes: () =>
              Effect.succeed({ comments: [comment, finding, reply], truncated: false }),
            listDiscussions: () =>
              Effect.succeed({
                threads: [],
                diffRefsByThreadId: new Map(),
                overviewFindingIds: ["10"],
                truncated: false,
              }),
          }),
        ),
      );

      const { comments } = yield* provider.getChangeRequestActivity(reference);

      expect(comments.map((item) => [item.id, item.kind])).toEqual([
        ["42", "issue-comment"],
        ["10", "review-comment"],
        ["11", "issue-comment"],
      ]);
    }),
  );

  it.effect("dates edited comments in the conversation and in threads", () =>
    Effect.gen(function* () {
      const editedAt = "2026-07-02T00:00:00Z";
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            ...reads,
            listDiscussions: () =>
              Effect.succeed({
                threads: [
                  {
                    id: "d1",
                    path: "src/a.ts",
                    line: 1,
                    side: "right" as const,
                    isResolved: false,
                    isOutdated: false,
                    comments: [comment],
                  },
                ],
                diffRefsByThreadId: new Map(),
                overviewFindingIds: [],
                truncated: false,
              }),
            listReactions: () =>
              Effect.succeed({
                reactions: [],
                reactionsByNoteId: new Map(),
                editedAtByNoteId: new Map([[comment.id, editedAt]]),
                botLogins: new Set<string>(),
              }),
          }),
        ),
      );

      const activity = yield* provider.getChangeRequestActivity(reference);

      expect(activity.comments[0]?.editedAt).toBe(editedAt);
      expect(activity.reviewThreads[0]?.comments[0]?.editedAt).toBe(editedAt);
    }),
  );

  it.effect("links comments and thread comments to their note on the merge request page", () =>
    Effect.gen(function* () {
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            ...reads,
            listDiscussions: () =>
              Effect.succeed({
                threads: [
                  {
                    id: "d1",
                    path: "src/a.ts",
                    line: 1,
                    side: "right" as const,
                    isResolved: false,
                    isOutdated: false,
                    comments: [comment],
                  },
                ],
                diffRefsByThreadId: new Map(),
                overviewFindingIds: [],
                truncated: false,
              }),
          }),
        ),
      );

      const activity = yield* provider.getChangeRequestActivity(reference);

      expect(activity.comments[0]?.url).toBe(`${webUrl}#note_42`);
      expect(activity.reviewThreads[0]?.comments[0]?.url).toBe(`${webUrl}#note_42`);
    }),
  );

  it.effect("marks a thread outdated once the merge request's diff moves past it", () =>
    Effect.gen(function* () {
      let detailReads = 0;
      const thread = (id: string) => ({
        id,
        path: "src/a.ts",
        line: 3,
        side: "right" as const,
        isResolved: false,
        isOutdated: false,
        comments: [],
      });
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            ...reads,
            getMergeRequestDetail: () =>
              Effect.map(reads.getMergeRequestDetail(), (detail) => ({
                ...detail,
                diffRefs: ++detailReads === 1 ? { ...currentRefs, headSha: "head1" } : currentRefs,
              })),
            listDiscussions: () =>
              Effect.succeed({
                threads: [thread("current"), thread("moved"), thread("unplaced")],
                diffRefsByThreadId: new Map([
                  ["current", currentRefs],
                  ["moved", { ...currentRefs, headSha: "head1" }],
                ]),
                overviewFindingIds: [],
                truncated: false,
              }),
          }),
        ),
      );

      const checks = provider.getChangeRequestChecks;
      if (!checks) throw new Error("missing getChangeRequestChecks");
      yield* checks(reference);
      const { reviewThreads } = yield* provider.getChangeRequestActivity(reference);
      expect(reviewThreads.map(({ id, isOutdated }) => [id, isOutdated])).toEqual([
        ["current", false],
        ["moved", true],
        ["unplaced", false],
      ]);
    }),
  );

  it.effect("keeps comments and commits when optional discussions, reactions and links fail", () =>
    Effect.gen(function* () {
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            ...reads,
            listDiscussions: () =>
              Effect.fail(
                new GitLabPullRequestCli.GitLabMergeRequestReadError({
                  command: "glab",
                  cwd: "/w",
                  operation: "listDiscussions",
                  cause: null,
                }),
              ),
            listReactions: () => Effect.fail(new GitLabCli.GitLabCliCommandError(context)),
            getMergeRequestDetail: () => Effect.fail(new GitLabCli.GitLabCliCommandError(context)),
          }),
        ),
      );

      expect(yield* provider.getChangeRequestActivity(reference)).toEqual({
        comments: [{ ...comment, reactions: [] }],
        commentCount: 1,
        commentsTruncated: true,
        reviewThreads: [],
        reactions: [],
        commits: [commit],
      });
    }),
  );

  it.effect("flags comments by bot authors as bots, in the conversation and in threads", () =>
    Effect.gen(function* () {
      const bot = { login: "project_1_bot_abc", name: "Review bot", avatarUrl: null };
      const human = { login: "alex", name: null, avatarUrl: null };
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            ...reads,
            listNotes: () =>
              Effect.succeed({
                comments: [
                  { ...comment, author: bot },
                  { ...comment, id: "43", author: human },
                ],
                truncated: false,
              }),
            listDiscussions: () =>
              Effect.succeed({
                threads: [
                  {
                    id: "d1",
                    path: "a.ts",
                    line: 1,
                    side: "right" as const,
                    isResolved: false,
                    isOutdated: false,
                    comments: [
                      { id: "44", author: bot, body: "x", createdAt: comment.createdAt, url: null },
                    ],
                  },
                ],
                diffRefsByThreadId: new Map(),
                overviewFindingIds: [],
                truncated: false,
              }),
            listReactions: () =>
              Effect.succeed({
                reactions: [],
                reactionsByNoteId: new Map(),
                editedAtByNoteId: new Map(),
                botLogins: new Set([bot.login.toUpperCase()]),
              }),
          }),
        ),
      );

      const activity = yield* provider.getChangeRequestActivity(reference);
      expect(activity.comments.map((entry) => entry.author?.isBot)).toEqual([true, undefined]);
      expect(activity.reviewThreads[0]?.comments[0]?.author?.isBot).toBe(true);
    }),
  );
});
