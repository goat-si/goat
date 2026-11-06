import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";
import {
  decodeListStatesJson,
  decodeGraphqlListSupportJson,
  decodeMergeRequestGraphqlListJson,
} from "./gitLabListState.ts";
function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) throw new Error("expected a successful decode");
  return result.success;
}

describe("decodeListStatesJson", () => {
  const statesOf = (enterprise: boolean | null, nodes: ReadonlyArray<unknown>) =>
    expectSuccess(
      decodeListStatesJson(
        JSON.stringify({
          data: {
            metadata: enterprise === null ? null : { enterprise },
            project: { mergeRequests: { nodes } },
          },
        }),
      ),
    );
  const approvedBy = (...usernames: ReadonlyArray<string>) => ({
    nodes: usernames.map((username) => ({ username })),
  });
  const reviewers = (...reviewStates: ReadonlyArray<string>) => ({
    nodes: reviewStates.map((reviewState) => ({ mergeRequestInteraction: { reviewState } })),
  });

  it.each([
    {
      reading: "an approval short of Enterprise approval rules",
      enterprise: true,
      approval: { approved: false, approvedBy: approvedBy("GitLabDuo") },
      decision: "review-required",
    },
    {
      reading: "Enterprise approval rules no one has approved against",
      enterprise: true,
      approval: { approved: false, approvedBy: approvedBy() },
      decision: "review-required",
    },
    {
      reading: "Enterprise approval rules met",
      enterprise: true,
      approval: { approved: true, approvedBy: approvedBy("alex") },
      decision: "approved",
    },
    {
      reading: "Enterprise without approval rules or approvals",
      enterprise: true,
      approval: { approved: true, approvedBy: approvedBy() },
      decision: null,
    },
    {
      reading: "Community Edition with an approval",
      enterprise: false,
      approval: { approved: true, approvedBy: approvedBy("alex") },
      decision: "approved",
    },
    {
      reading: "Community Edition without approvals",
      enterprise: false,
      approval: { approved: false, approvedBy: approvedBy() },
      decision: null,
    },
    {
      reading: "a reviewer requesting changes after another approved",
      enterprise: true,
      approval: {
        approved: true,
        approvedBy: approvedBy("julius"),
        reviewers: reviewers("APPROVED", "REQUESTED_CHANGES"),
      },
      decision: "changes-requested",
    },
    {
      reading: "a Community Edition reviewer requesting changes",
      enterprise: false,
      approval: {
        approved: false,
        approvedBy: approvedBy(),
        reviewers: reviewers("REQUESTED_CHANGES"),
      },
      decision: "changes-requested",
    },
    {
      reading: "reviewers who have not asked for changes",
      enterprise: false,
      approval: {
        approved: true,
        approvedBy: approvedBy("julius"),
        reviewers: reviewers("UNREVIEWED", "REVIEWED"),
      },
      decision: "approved",
    },
  ])("reads $reading as $decision", ({ enterprise, approval, decision }) => {
    expect([...statesOf(enterprise, [{ iid: "7", ...approval }])]).toEqual([
      [7, { reviewDecision: decision, checksState: null }],
    ]);
  });

  it.each([
    { pipeline: { status: "SUCCESS" }, checksState: "passing" },
    { pipeline: { status: "FAILED" }, checksState: "failing" },
    { pipeline: { status: "CANCELED" }, checksState: "failing" },
    { pipeline: { status: "RUNNING" }, checksState: "pending" },
    { pipeline: { status: "WAITING_FOR_RESOURCE" }, checksState: "pending" },
    { pipeline: { status: "MANUAL" }, checksState: null },
    { pipeline: { status: "SKIPPED" }, checksState: null },
    { pipeline: null, checksState: null },
  ])(
    "reads a $pipeline.status head pipeline as $checksState checks",
    ({ pipeline, checksState }) => {
      expect([
        ...statesOf(false, [
          { iid: "7", approved: false, approvedBy: approvedBy(), headPipeline: pipeline },
        ]),
      ]).toEqual([[7, { reviewDecision: null, checksState }]]);
    },
  );

  it("leaves out a merge request it cannot key, and a project the reader cannot see", () => {
    expect([...statesOf(true, [null, { iid: "x", approved: true }])]).toEqual([]);
    expect(
      expectSuccess(decodeListStatesJson(JSON.stringify({ data: { project: null } }))),
    ).toEqual(new Map());
  });

  it("keeps the checks of a merge request whose approval it cannot judge", () => {
    expect([
      ...statesOf(null, [
        {
          iid: "7",
          approved: false,
          approvedBy: approvedBy(),
          headPipeline: { status: "FAILED" },
        },
      ]),
      ...statesOf(true, [
        { iid: "8", approved: null, approvedBy: approvedBy("julius") },
        { iid: "9", approved: true, approvedBy: null },
      ]),
    ]).toEqual([
      [7, { checksState: "failing" }],
      [8, { checksState: null }],
      [9, { checksState: null }],
    ]);
  });
});

describe("decodeMergeRequestGraphqlListJson", () => {
  it("reads a row and its review state in one page, counting rows it cannot read", () => {
    const page = expectSuccess(
      decodeMergeRequestGraphqlListJson(
        JSON.stringify({
          data: {
            metadata: { enterprise: false },
            project: {
              mergeRequests: {
                pageInfo: { hasNextPage: true, endCursor: "eyJpZCI6IjcifQ" },
                nodes: [
                  {
                    iid: "7",
                    title: "Add the merge requests page",
                    webUrl: "https://gitlab.com/acme/web/-/merge_requests/7",
                    state: "opened",
                    draft: true,
                    createdAt: "2026-07-01T00:00:00Z",
                    updatedAt: "2026-07-02T00:00:00Z",
                    sourceBranch: "feat/page",
                    targetBranch: "main",
                    conflicts: true,
                    mergeStatusEnum: "CHECKING",
                    author: { username: "bilal", name: "Bilal", avatarUrl: null },
                    labels: { nodes: [{ title: "bug" }] },
                    approved: false,
                    approvedBy: { nodes: [] },
                    reviewers: {
                      nodes: [
                        {
                          username: "julius",
                          mergeRequestInteraction: { reviewState: "REQUESTED_CHANGES" },
                        },
                      ],
                    },
                    headPipeline: { status: "FAILED" },
                  },
                  { iid: "8" },
                ],
              },
            },
          },
        }),
      ),
    );

    expect(page.items).toEqual([
      expect.objectContaining({
        number: 7,
        state: "open",
        isDraft: true,
        mergeability: "conflicting",
        reviewRequestLogins: ["julius"],
        labels: [expect.objectContaining({ name: "bug" })],
      }),
    ]);
    expect([...page.states]).toEqual([
      [7, { reviewDecision: "changes-requested", checksState: "failing" }],
    ]);
    expect(page).toMatchObject({ rawCount: 2, hasNextPage: true, endCursor: "eyJpZCI6IjcifQ" });
  });
  it("fails on a project the reader cannot see, rather than reading it as empty", () => {
    expect(
      Result.isFailure(
        decodeMergeRequestGraphqlListJson(
          JSON.stringify({ data: { metadata: { enterprise: true }, project: null } }),
        ),
      ),
    ).toBe(true);
  });
});

describe("decodeGraphqlListSupportJson", () => {
  it.each([
    { version: "17.8.4", supported: false },
    { version: "17.9.0", supported: true },
    { version: "19.6.0-pre", supported: true },
    { version: null, supported: false },
  ])("reads GitLab $version as supported: $supported", ({ version, supported }) => {
    expect(
      expectSuccess(
        decodeGraphqlListSupportJson(JSON.stringify({ data: { metadata: { version } } })),
      ),
    ).toBe(supported);
  });
});
