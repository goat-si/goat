import { SourceControlProviderKind } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { PROJECT_ID, makeHarness } from "./handlers.testkit.ts";

describe("pull request reads within the budget", () => {
  it.effect(
    "keeps a search, a file and a conversation within 256 KiB and says what it left out",
    () =>
      Effect.gen(function* () {
        const big = "x".repeat(200 * 1024);
        const comment = (id: string) => ({
          id,
          kind: "issue-comment" as const,
          author: null,
          body: big,
          createdAt: "2026-10-01T00:00:00.000Z",
          url: null,
          path: null,
          reviewState: null,
        });
        const entry = (number: number) => ({
          provider: SourceControlProviderKind.make("github"),
          host: "github.com",
          projectId: PROJECT_ID,
          projectTitle: "Project",
          repository: "sample-tools/goat",
          number,
          title: `PR ${number}`,
          url: `https://github.com/sample-tools/goat/pull/${number}`,
          author: null,
          headBranch: "feature",
          baseBranch: "main",
          state: "open" as const,
          isDraft: false,
          mergeability: "mergeable" as const,
          additions: 0,
          deletions: 0,
          createdAt: "2026-10-01T00:00:00.000Z",
          updatedAt: "2026-10-01T00:00:00.000Z",
          viewerReviewRequested: false,
          labels: [],
        });
        const harness = yield* makeHarness({
          service: {
            activity: () =>
              Effect.succeed({
                comments: [comment("c1"), comment("c2")],
                commentCount: 2,
                commentsTruncated: false,
                reviewThreads: [],
                commits: [1, 2].map((n) => ({
                  oid: `commit-${n}`,
                  messageHeadline: big,
                  committedDate: "2026-10-01T00:00:00.000Z",
                })),
              }),
            diffFileContents: () =>
              Effect.succeed({ oldContents: "é".repeat(200 * 1024), newContents: "ok" }),
            list: (input) =>
              Effect.succeed({
                viewers: {},
                providers: [],
                entries:
                  input.query === "huge"
                    ? [
                        { ...entry(4), title: big },
                        { ...entry(5), title: big },
                      ]
                    : [entry(1), entry(2), entry(3)],
                errors: [],
                truncated: true,
                nextCursors: { "github.com/sample-tools/goat": "next" },
              }),
          },
        });
        const target = { url: "https://github.com/sample-tools/goat/pull/12" };
        const activity = yield* harness.call("goat_pull_request_activity", target);
        // Every list shares one budget: commits after the kept comment are counted as left out.
        expect(activity.activity.comments.map((kept) => kept.id)).toEqual(["c1"]);
        expect([activity.commentsOmitted, activity.commitsOmitted]).toEqual([1, 2]);
        expect(Buffer.byteLength(JSON.stringify(activity), "utf8")).toBeLessThanOrEqual(256 * 1024);
        const file = yield* harness.call("goat_pull_request_file", {
          ...target,
          changeType: "change",
          oldPath: "a.ts",
          newPath: "a.ts",
        });
        expect(Buffer.byteLength(file.oldContents, "utf8")).toBeLessThanOrEqual(256 * 1024);
        expect(file.oldContents.endsWith("é")).toBe(true);
        expect([file.oldTruncated, file.newTruncated]).toEqual([true, false]);
        // Rows are never cut, so the service's cursors continue without a gap.
        const page = yield* harness.call("goat_pull_request_search", { state: "open", limit: 2 });
        expect(page.entries).toHaveLength(3);
        expect(page).toMatchObject({
          truncated: true,
          nextCursors: { "github.com/sample-tools/goat": "next" },
        });
        const huge = yield* harness
          .call("goat_pull_request_search", { state: "open", query: "huge" })
          .pipe(Effect.flip);
        expect(huge._tag).toBe("PullRequestSearchTooLargeError");
      }),
  );
});
