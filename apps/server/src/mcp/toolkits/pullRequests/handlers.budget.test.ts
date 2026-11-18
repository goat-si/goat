import { SourceControlProviderKind } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { PROJECT_ID, makeHarness } from "./handlers.testkit.ts";
import { bytesOf, READ_BUDGET_BYTES } from "./readBudget.ts";

describe("pull request reads within the budget", () => {
  it.effect(
    "keeps a search, a file and a conversation within 256 KiB and says what it left out",
    () =>
      Effect.gen(function* () {
        const big = "x".repeat(200 * 1024);
        const longUrl = `https://github.com/sample-tools/goat/pull/4?${"a".repeat(1500)}`;
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
                author: { login: "someone", name: "n".repeat(300 * 1024), avatarUrl: null },
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
            // A page that fits by itself but not beside the response's identity and cursor.
            threadComments: () =>
              Effect.succeed({
                comments: [{ ...comment("t1"), body: "x".repeat(256 * 1024 - 200) }],
                nextCursor: "next",
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
                        { ...entry(4), title: "\u0001".repeat(4096), url: longUrl },
                        { ...entry(5), title: big },
                      ]
                    : input.query === "many"
                      ? Array.from({ length: 300 }, (_, i) => ({
                          ...entry(i + 1),
                          title: "t".repeat(1000),
                        }))
                      : [entry(1), entry(2), entry(3)],
                errors: [],
                truncated: true,
                nextCursors: { "github.com/sample-tools/goat": "next" },
              }),
          },
        });
        const target = { url: "https://github.com/sample-tools/goat/pull/12" };
        const within = (value: unknown) =>
          expect(Buffer.byteLength(JSON.stringify(value), "utf8")).toBeLessThanOrEqual(256 * 1024);
        const activity = yield* harness.call("goat_pull_request_activity", target);
        // Every list shares one budget: commits after the kept comment are counted as left out.
        expect(activity.activity.comments.map((kept) => kept.id)).toEqual(["c1"]);
        expect([activity.commentsOmitted, activity.commitsOmitted]).toEqual([1, 2]);
        within(activity);
        const thread = yield* harness.call("goat_pull_request_review_thread", {
          ...target,
          threadId: "thread-1",
          cursor: "start",
        });
        expect([thread.comments.length, thread.commentsOmitted]).toEqual([0, 1]);
        within(thread);
        // A target whose echo alone overruns the budget is refused instead of answered oversized.
        const longTarget = { url: `${target.url}?${"q".repeat(300 * 1024)}` };
        const refusedActivity = yield* harness
          .call("goat_pull_request_activity", longTarget)
          .pipe(Effect.flip);
        const refusedThread = yield* harness
          .call("goat_pull_request_review_thread", {
            ...longTarget,
            threadId: "thread-1",
            cursor: "start",
          })
          .pipe(Effect.flip);
        expect([refusedActivity._tag, refusedThread._tag]).toEqual([
          "PullRequestReadTooLargeError",
          "PullRequestReadTooLargeError",
        ]);
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
        // One oversized row is clipped to a bounded form, so narrowing always makes progress.
        const huge = yield* harness.call("goat_pull_request_search", {
          state: "open",
          query: "huge",
        });
        expect(huge.entries.map((row) => row.number)).toEqual([4, 5]);
        expect(huge.rowsClipped).toBe(true);
        // Identifiers stay whole for follow-up reads; text is cut by its escaped JSON size.
        expect(huge.entries[0]?.url).toBe(longUrl);
        expect(Buffer.byteLength(JSON.stringify(huge.entries[0]?.title))).toBeLessThanOrEqual(1026);
        within(huge);
        const many = yield* harness
          .call("goat_pull_request_search", { state: "open", query: "many" })
          .pipe(Effect.flip);
        expect(many._tag).toBe("PullRequestReadTooLargeError");
      }),
  );
});

describe("GitLab overview threads in the activity read", () => {
  it.effect("leaves room for the overview omission count before fitting the last thread", () =>
    Effect.gen(function* () {
      const activity = {
        reviewers: [],
        comments: [],
        commentCount: 0,
        commentsTruncated: false,
        reviewThreads: [],
        commits: [],
        reactions: [],
        overviewThreads: [],
      };
      const thread = {
        id: "overview",
        path: null,
        line: null,
        side: "right" as const,
        isResolved: false,
        isOutdated: false,
        comments: [],
      };
      let threadId = thread.id;
      const harness = yield* makeHarness({
        service: {
          activity: () =>
            Effect.succeed({ ...activity, overviewThreads: [{ ...thread, id: threadId }] }),
        },
      });
      const target = { url: "https://github.com/sample-tools/goat/pull/12" };
      const read = yield* harness.call("goat_pull_request_activity", target);
      const { overviewThreadsOmitted: _omitted, ...reply } = read;
      const count = 999_999_999;
      const shell = {
        ...reply,
        activity: { ...read.activity, overviewThreads: [] },
        commentsOmitted: count,
        reviewThreadsOmitted: count,
        commitsOmitted: count,
        reviewersOmitted: count,
        reactionsOmitted: count,
      };
      threadId += "x".repeat(READ_BUDGET_BYTES - bytesOf(shell) - bytesOf(thread) - 1);
      const full = yield* harness.call("goat_pull_request_activity", target);
      expect(full.activity.overviewThreads).toHaveLength(0);
      expect(full.overviewThreadsOmitted).toBe(1);
    }),
  );

  it.effect(
    "fits overview threads into the read's budget, counts those left out, and omits the list when there is none",
    () =>
      Effect.gen(function* () {
        const thread = (id: string) => ({
          id,
          path: null,
          line: null,
          side: "right" as const,
          isResolved: false,
          isOutdated: false,
          comments: [
            {
              id: `${id}-note`,
              author: null,
              body: "x".repeat(200 * 1024),
              createdAt: "2026-10-01T00:00:00.000Z",
              url: null,
            },
          ],
        });
        const base = {
          comments: [],
          commentCount: 0,
          commentsTruncated: false,
          reviewThreads: [],
          commits: [],
        };
        let overview = true;
        const harness = yield* makeHarness({
          service: {
            activity: () =>
              Effect.succeed(
                overview ? { ...base, overviewThreads: [thread("o1"), thread("o2")] } : base,
              ),
          },
        });
        // The read does not depend on the host; the harness project is a GitHub checkout.
        const target = { url: "https://github.com/sample-tools/goat/pull/12" };
        const read = yield* harness.call("goat_pull_request_activity", target);
        expect(read.activity.overviewThreads?.map(({ id }) => id)).toEqual(["o1"]);
        expect(read.overviewThreadsOmitted).toBe(1);
        expect(Buffer.byteLength(JSON.stringify(read), "utf8")).toBeLessThanOrEqual(256 * 1024);

        overview = false;
        const plain = yield* harness.call("goat_pull_request_activity", target);
        expect(plain.activity).not.toHaveProperty("overviewThreads");
        expect(plain).not.toHaveProperty("overviewThreadsOmitted");
      }),
  );
});
