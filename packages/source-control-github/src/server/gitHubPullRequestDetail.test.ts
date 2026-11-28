import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";
import { through } from "./gitHubPullRequestJsonTestFixtures.ts";
import {
  decodePullRequestDetailJson,
  toPullRequestActivityPage,
  toPullRequestCore,
} from "./gitHubPullRequestJson.ts";
import { PullRequestActivity, PullRequestCore } from "./pullRequestReads.graphql.ts";

const decodePullRequestActivityJson = through(
  PullRequestActivity.result,
  toPullRequestActivityPage,
);
const decodePullRequestCoreJson = through(PullRequestCore.result, toPullRequestCore);
function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) throw new Error("expected a successful decode");
  return result.success;
}

describe("pull request detail decoding", () => {
  const check = (fields: Record<string, unknown>) =>
    fields["__typename"] === "StatusContext"
      ? {
          context: "",
          state: "PENDING",
          targetUrl: null,
          createdAt: "2026-07-01T00:00:00Z",
          description: null,
          ...fields,
        }
      : {
          __typename: "CheckRun",
          name: "",
          status: "COMPLETED",
          conclusion: null,
          startedAt: null,
          completedAt: null,
          detailsUrl: null,
          checkSuite: { workflowRun: null },
          ...fields,
        };
  const inWorkflow = ({
    workflowName,
    workflowId = `W_kwDORLtfbc4${String(workflowName)}`,
    event = "pull_request",
    runNumber = 95380,
    ...fields
  }: Record<string, unknown>) =>
    check({
      ...fields,
      checkSuite: {
        workflowRun: { event, runNumber, workflow: { id: workflowId, name: workflowName } },
      },
    });

  const coreJson = (
    rollup: ReadonlyArray<Record<string, unknown>>,
    pullRequest: Record<string, unknown> = {},
  ) =>
    JSON.stringify({
      data: {
        repository: {
          mergeCommitAllowed: true,
          squashMergeAllowed: true,
          rebaseMergeAllowed: true,
          autoMergeAllowed: true,
          viewerPermission: "WRITE",
          pullRequest: {
            number: 7,
            title: "Detail",
            url: "https://github.com/goat-si/goat/pull/7",
            body: "Body",
            state: "OPEN",
            isDraft: false,
            mergeable: "MERGEABLE",
            mergeStateStatus: "BLOCKED",
            reviewDecision: null,
            additions: 0,
            deletions: 0,
            changedFiles: 0,
            createdAt: "2026-07-01T00:00:00Z",
            updatedAt: "2026-07-05T00:00:00Z",
            mergedAt: null,
            closedAt: null,
            headRefName: "feat/detail",
            baseRefName: "main",
            headRefOid: "abc123",
            isCrossRepository: false,
            maintainerCanModify: true,
            headRepositoryOwner: null,
            headRepository: null,
            headRef: null,
            author: null,
            autoMergeRequest: null,
            viewerCanUpdate: true,
            viewerDidAuthor: false,
            viewerCanUpdateBranch: false,
            baseRef: null,
            reviewRequests: { nodes: [] },
            labels: { nodes: [] },
            commits: {
              nodes: [
                {
                  commit: {
                    statusCheckRollup: {
                      contexts: { nodes: rollup, pageInfo: { hasNextPage: false } },
                    },
                  },
                },
              ],
            },
            ...pullRequest,
          },
        },
      },
    });
  const detailOf = (
    rollup: ReadonlyArray<Record<string, unknown>>,
    pullRequest?: Record<string, unknown>,
  ) => expectSuccess(decodePullRequestCoreJson(coreJson(rollup, pullRequest)));

  it.each([
    [{}, true],
    [{ viewerDidAuthor: false }, false],
    [{ isCrossRepository: false }, false],
    [{ state: "CLOSED" }, false],
    [{ headRepositoryOwner: { __typename: "Organization", login: "team" } }, false],
    [{ headRepository: null }, false],
  ])(
    "reads maintainer edits and lets only the author of an open personal fork change them: %j",
    (overrides, allowed) => {
      const detail = detailOf([], {
        maintainerCanModify: false,
        isCrossRepository: true,
        viewerDidAuthor: true,
        headRepositoryOwner: { __typename: "User", login: "octocat" },
        headRepository: { nameWithOwner: "octocat/goat", viewerPermission: "ADMIN" },
        headRef: { id: "REF_7" },
        ...overrides,
      });
      expect(detail.maintainerCanModify).toBe(false);
      expect(detail.canEditMaintainerEdits).toBe(allowed);
    },
  );

  const detailJson = JSON.stringify({
    comments: [{ id: "c1", body: "second", createdAt: "2026-07-04T00:00:00Z" }],
    reviews: [
      { id: "r1", body: "first", state: "CHANGES_REQUESTED", submittedAt: "2026-07-03T00:00:00Z" },
      { id: "r2", body: "   ", state: "APPROVED", submittedAt: "2026-07-06T00:00:00Z" },
    ],
    commits: [
      {
        oid: "abc1234",
        messageHeadline: "Ship the timeline",
        committedDate: "2026-07-05T00:00:00Z",
        authors: [
          { login: "octocat", name: "Octo Cat", email: "octo@example.com" },
          { name: "Pair Author", email: "pair@example.com" },
        ],
      },
    ],
  });

  const activityJson = (raw: Record<string, unknown>) =>
    JSON.stringify({
      data: {
        repository: {
          pullRequest: {
            author: null,
            comments: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: ((raw["comments"] ?? []) as ReadonlyArray<Record<string, unknown>>).map(
                (comment) => ({
                  lastEditedAt: null,
                  url: "https://github.com/c",
                  isMinimized: false,
                  author: null,
                  ...comment,
                }),
              ),
            },
            reviews: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: ((raw["reviews"] ?? []) as ReadonlyArray<Record<string, unknown>>).map(
                (review) => ({
                  lastEditedAt: null,
                  url: "https://github.com/r",
                  isMinimized: false,
                  author: null,
                  submittedAt: null,
                  ...review,
                }),
              ),
            },
            commits: {
              nodes: ((raw["commits"] ?? []) as ReadonlyArray<Record<string, unknown>>).map(
                ({ authors, ...commit }) => ({
                  commit: {
                    id: "commit-id",
                    parents: { totalCount: 1 },
                    ...commit,
                    authors: {
                      nodes: ((authors ?? []) as ReadonlyArray<Record<string, unknown>>).map(
                        ({ login, ...author }) => ({
                          name: null,
                          email: null,
                          ...author,
                          user: login === undefined ? null : { login },
                        }),
                      ),
                    },
                  },
                }),
              ),
            },
          },
        },
      },
    });
  const activity = (raw: Record<string, unknown>) =>
    Result.map(decodePullRequestActivityJson(activityJson(raw)), (page) => ({
      comments: page.remarks.toSorted((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      ),
      commits: page.commits ?? [],
    }));

  it("keeps a workflow waiting for approval out of the passing state", () => {
    const detail = detailOf([
      check({ name: "build", status: "COMPLETED", conclusion: "SUCCESS" }),
      check({ name: "contributor tests", status: "COMPLETED", conclusion: "ACTION_REQUIRED" }),
    ]);

    expect(detail.checks.map((check) => check.status)).toEqual(["success", "action-required"]);
    expect(detail.checksState).toBe("pending");
  });

  it("reads an auto-merge request and strategy, its null as off and its absence as neither", () => {
    expect(detailOf([], { autoMergeRequest: { mergeMethod: "SQUASH" } })).toMatchObject({
      autoMergeEnabled: true,
      autoMergeMethod: "squash",
    });
    expect(detailOf([], { autoMergeRequest: null }).autoMergeEnabled).toBe(false);
    expect(
      expectSuccess(
        decodePullRequestDetailJson(
          JSON.stringify({
            number: 7,
            title: "Detail",
            url: "https://github.com/goat-si/goat/pull/7",
            headRefName: "feat/detail",
            baseRefName: "main",
            createdAt: "2026-07-01T00:00:00Z",
            updatedAt: "2026-07-05T00:00:00Z",
          }),
        ),
      ).autoMergeEnabled,
    ).toBeUndefined();
  });

  it("reads the newest merge queue removal, and none where the queue was not asked about", () => {
    const removal = {
      __typename: "RemovedFromMergeQueueEvent",
      id: "RMQE_1",
      createdAt: "2026-07-05T00:00:00Z",
      reason: "Required status checks failed",
    };
    expect(detailOf([], { mergeQueueRemovals: { nodes: [removal] } }).mergeQueueRemoval).toEqual({
      id: "RMQE_1",
      removedAt: "2026-07-05T00:00:00Z",
      reason: "Required status checks failed",
    });
    expect(detailOf([], { mergeQueueRemovals: { nodes: [] } }).mergeQueueRemoval).toBeUndefined();
    expect(detailOf([]).mergeQueueRemoval).toBeUndefined();
  });

  it("shows a re-running check once, as the run that is happening now", () => {
    const detail = detailOf([
      inWorkflow({
        name: "Prepare PR size config",
        workflowName: "PR Size",
        status: "COMPLETED",
        conclusion: "SUCCESS",
        startedAt: "2026-08-11T16:06:20Z",
        completedAt: "2026-08-11T16:06:25Z",
      }),
      inWorkflow({
        name: "Prepare PR size config",
        workflowName: "PR Size",
        status: "IN_PROGRESS",
        conclusion: null,
        startedAt: "2026-08-11T17:01:04Z",
        completedAt: "0001-01-01T00:00:00Z",
      }),
    ]);

    expect(detail.checks.map((check) => [check.name, check.status])).toEqual([
      ["Prepare PR size config", "pending"],
    ]);
    expect(detail.checksState).toBe("pending");
  });

  it("keeps a check pending while another run of it on the same commit is still going", () => {
    const finished = {
      name: "check",
      workflowName: "Checks",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      startedAt: "2026-10-08T04:06:10Z",
      completedAt: "2026-10-08T04:18:58Z",
    };
    const running = {
      ...finished,
      status: "IN_PROGRESS",
      conclusion: null,
      startedAt: "2026-10-08T04:06:13Z",
      completedAt: "0001-01-01T00:00:00Z",
    };
    const queued = { ...running, status: "QUEUED", startedAt: "0001-01-01T00:00:00Z" };
    const checksOf = (rollup: ReadonlyArray<Record<string, unknown>>) => {
      const detail = detailOf(rollup.map(inWorkflow));
      return [detail.checks.map((check) => [check.name, check.status]), detail.checksState];
    };

    for (const rollup of [
      [finished, running],
      [running, finished],
      [finished, queued],
      [queued, finished],
    ]) {
      expect(checksOf(rollup)).toEqual([[["check", "pending"]], "pending"]);
    }
  });

  it("drops a cancelled check whose workflow run was superseded by a newer run on the head", () => {
    const superseded = {
      workflowName: "CI",
      workflowId: "W_kwDORLtfbc4N00ni",
      runNumber: 95379,
      status: "COMPLETED",
      startedAt: "2026-10-30T10:00:00Z",
      completedAt: "2026-10-30T10:00:05Z",
    };
    const replacement = {
      workflowName: "CI",
      workflowId: "W_kwDORLtfbc4N00ni",
      runNumber: 95380,
      status: "COMPLETED",
      conclusion: "SUCCESS",
      startedAt: "2026-10-30T10:00:10Z",
      completedAt: "2026-10-30T10:05:00Z",
    };
    const rollup = [
      inWorkflow({ ...superseded, name: "check", conclusion: "CANCELLED" }),
      inWorkflow({
        ...superseded,
        name: "web browser tests (runner ${{ matrix.slice }} of 6)",
        conclusion: "CANCELLED",
      }),
      inWorkflow({ ...replacement, name: "check" }),
      inWorkflow({ ...replacement, name: "web browser tests (runner 1 of 6)" }),
      inWorkflow({ ...replacement, name: "web browser tests (runner 2 of 6)" }),
    ];
    const detail = detailOf(rollup);

    expect([detail.checks.map((check) => [check.name, check.status]), detail.checksState]).toEqual([
      [
        ["check", "success"],
        ["web browser tests (runner 1 of 6)", "success"],
        ["web browser tests (runner 2 of 6)", "success"],
      ],
      "passing",
    ]);
  });

  it("keeps a cancelled check when the newer run is another workflow with the same name", () => {
    const detail = detailOf([
      inWorkflow({
        name: "test",
        workflowName: "CI",
        workflowId: "W_kwDORLtfbc4N00ni",
        runNumber: 95379,
        conclusion: "CANCELLED",
      }),
      inWorkflow({
        name: "lint",
        workflowName: "CI",
        workflowId: "W_kwDORLtfbc4ToKTh",
        runNumber: 95380,
        conclusion: "SUCCESS",
      }),
    ]);

    expect(detail.checks.map((check) => [check.name, check.status])).toContainEqual([
      "test",
      "cancelled",
    ]);
    expect(detail.checksState).toBe("failing");
  });

  it("drops a required cancelled check once a newer run reports it, whenever it finished", () => {
    const detail = detailOf([
      inWorkflow({
        name: "test",
        workflowName: "CI",
        runNumber: 41,
        conclusion: "CANCELLED",
        isRequired: true,
        startedAt: "2026-10-30T10:00:00Z",
        completedAt: "2026-10-30T10:09:00Z",
      }),
      inWorkflow({
        name: "test",
        workflowName: "CI",
        runNumber: 42,
        conclusion: "SUCCESS",
        isRequired: true,
        startedAt: "2026-10-30T10:01:00Z",
        completedAt: "2026-10-30T10:05:00Z",
      }),
    ]);

    expect(detail.checks.map((check) => [check.name, check.status])).toEqual([["test", "success"]]);
    expect(detail.checksState).toBe("passing");
  });

  it.each([
    ["a push", "push", "push", "CANCELLED", false, "cancelled"],
    ["another event", "pull_request", "pull_request_target", "CANCELLED", false, "cancelled"],
    ["a pull request run", "pull_request", "pull_request", "FAILURE", false, "failure"],
    [
      "a pull request run, if required",
      "pull_request",
      "pull_request",
      "CANCELLED",
      true,
      "cancelled",
    ],
  ])(
    "keeps an older run's check when the newer run is %s",
    (_label, olderEvent, newerEvent, conclusion, isRequired, status) => {
      const detail = detailOf([
        inWorkflow({
          name: "test (packages/shared)",
          workflowName: "CI",
          event: olderEvent,
          runNumber: 41,
          conclusion,
          isRequired,
        }),
        inWorkflow({
          name: "test (apps/server)",
          workflowName: "CI",
          event: newerEvent,
          runNumber: 42,
          conclusion: "SUCCESS",
        }),
      ]);

      expect(detail.checks.map((check) => [check.name, check.status])).toContainEqual([
        "test (packages/shared)",
        status,
      ]);
      expect(detail.checksState).toBe("failing");
    },
  );

  it("merges reviews with comments in time order and keeps a bodyless approval", () => {
    const detail = expectSuccess(activity(JSON.parse(detailJson) as Record<string, unknown>));
    expect(detail.comments.map((comment) => comment.id)).toEqual(["r1", "c1", "r2"]);
    expect(detail.comments.at(-1)?.reviewState).toBe("APPROVED");
  });

  it("drops the bodyless review GitHub opens to hold line comments", () => {
    const raw = JSON.parse(detailJson) as Record<string, unknown>;
    const detail = expectSuccess(
      activity({
        ...raw,
        reviews: [
          { id: "r4", body: "", state: "COMMENTED", submittedAt: "2026-07-07T00:00:00Z" },
          {
            id: "r5",
            body: "Looks good.",
            state: "COMMENTED",
            submittedAt: "2026-07-08T00:00:00Z",
          },
        ],
      }),
    );

    expect(detail.comments.map((comment) => comment.id)).toEqual(["c1", "r5"]);
  });

  it("leaves out the comments and reviews a maintainer hid", () => {
    const detail = expectSuccess(
      activity({
        comments: [
          { id: "c1", body: "kept", createdAt: "2026-07-04T00:00:00Z" },
          { id: "c2", body: "spam", createdAt: "2026-07-05T00:00:00Z", isMinimized: true },
        ],
        reviews: [
          {
            id: "r1",
            body: "spam",
            state: "CHANGES_REQUESTED",
            submittedAt: "2026-07-03T00:00:00Z",
            isMinimized: true,
          },
          { id: "r2", body: "", state: "APPROVED", submittedAt: "2026-07-06T00:00:00Z" },
        ],
      }),
    );

    expect(detail.comments.map((comment) => comment.id)).toEqual(["c1", "r2"]);
  });

  it.each(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"])(
    "keeps a bodyless %s review, which is the event itself",
    (state) => {
      const raw = JSON.parse(detailJson) as Record<string, unknown>;
      const detail = expectSuccess(
        activity({
          ...raw,
          reviews: [{ id: "r6", body: "", state, submittedAt: "2026-07-07T00:00:00Z" }],
        }),
      );

      expect(detail.comments.map((comment) => comment.id)).toContain("r6");
    },
  );
});
