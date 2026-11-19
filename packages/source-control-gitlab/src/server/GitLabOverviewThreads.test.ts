import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import { make } from "./GitLabPullRequestProvider.ts";
import { GitLabMutationRefusedError } from "./gitLabPullRequestErrors.ts";

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
const reads = {
  getMergeRequestDetail: () =>
    Effect.succeed({
      number: 7,
      title: "Merge request 7",
      url: "https://gitlab.com/acme/web/-/merge_requests/7",
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
      reviewerUsers: [],
      diffRefs: { baseSha: "base", startSha: "start", headSha: "head" },
    }),
  listNotes: () => Effect.succeed({ comments: [comment], truncated: false }),
  listCommits: () => Effect.succeed([]),
  listReactions: () =>
    Effect.succeed({
      reactions: [],
      reactionsByNoteId: new Map(),
      editedAtByNoteId: new Map(),
      botLogins: new Set<string>(),
    }),
};
const thread = { side: "right", isResolved: false, isOutdated: false, comments: [] } as const;

describe("GitLab overview threads", () => {
  it.effect(
    "turns an open overview discussion into a finding and a thread apart from file threads",
    () =>
      Effect.gen(function* () {
        const finding = { ...comment, id: "10", body: "Mention the flag in the README" };
        const provider = yield* make.pipe(
          Effect.provide(
            Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
              ...reads,
              listNotes: () => Effect.succeed({ comments: [comment, finding], truncated: false }),
              listDiscussions: () =>
                Effect.succeed({
                  threads: [
                    { ...thread, id: "overview", path: null, line: null },
                    { ...thread, id: "file", path: "src/a.ts", line: 3 },
                  ],
                  diffRefsByThreadId: new Map(),
                  overviewFindingIds: ["10"],
                  truncated: false,
                }),
            }),
          ),
        );

        const { comments, reviewThreads, overviewThreads } =
          yield* provider.getChangeRequestActivity(reference);

        // Clients that require a thread path must never receive one without it.
        expect(reviewThreads.map(({ id }) => id)).toEqual(["file"]);
        expect(overviewThreads?.map(({ id }) => id)).toEqual(["overview"]);
        // Older clients keep seeing the overview remark as a finding, as before.
        expect(comments.map((item) => [item.id, item.kind])).toEqual([
          ["42", "issue-comment"],
          ["10", "review-comment"],
        ]);
      }),
  );

  it.effect("leaves the overview list out when a merge request has none", () =>
    Effect.gen(function* () {
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            ...reads,
            listDiscussions: () =>
              Effect.succeed({
                threads: [{ ...thread, id: "file", path: "src/a.ts", line: 3 }],
                diffRefsByThreadId: new Map(),
                overviewFindingIds: [],
                truncated: false,
              }),
          }),
        ),
      );
      expect(yield* provider.getChangeRequestActivity(reference)).not.toHaveProperty(
        "overviewThreads",
      );
    }),
  );

  it.effect("resolves an overview thread by its discussion id, and reports GitLab's refusal", () =>
    Effect.gen(function* () {
      const resolved: Array<{ discussionId: string; resolved: boolean }> = [];
      let refuse = false;
      const provider = yield* make.pipe(
        Effect.provide(
          Layer.mock(GitLabPullRequestCli.GitLabPullRequestCli)({
            ...reads,
            setDiscussionResolution: ({ discussionId, resolved: value }) =>
              refuse
                ? Effect.fail(
                    new GitLabMutationRefusedError({
                      command: "glab",
                      cwd: "/w",
                      operation: "setDiscussionResolution",
                      reasons: ["403 Forbidden"],
                    }),
                  )
                : Effect.sync(() => void resolved.push({ discussionId, resolved: value })),
          }),
        ),
      );
      yield* provider.setThreadResolution({ ...reference, threadId: "overview", resolved: true });
      expect(resolved).toEqual([{ discussionId: "overview", resolved: true }]);

      refuse = true;
      const error = yield* provider
        .setThreadResolution({ ...reference, threadId: "overview", resolved: false })
        .pipe(Effect.flip);
      expect(error.operation).toBe("setThreadResolution");
      expect(error.detail).toContain("403");
    }),
  );
});
