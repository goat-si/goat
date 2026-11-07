import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";

const author = { id: 1, username: "bilal" };
const reviewer = { id: 5, username: "octocat" };
const labelPermission = output(
  JSON.stringify({
    data: { project: { mergeRequest: { userPermissions: { updateMergeRequest: true } } } },
  }),
);
function mergeRequestJson(overrides: Record<string, unknown>) {
  return JSON.stringify({
    iid: 7,
    title: "Merge request 7",
    web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
    source_branch: "feat/page",
    target_branch: "main",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    author,
    ...overrides,
  });
}

const mockedExecute = vi.fn<GitLabCli.GitLabCli["Service"]["execute"]>();
const layer = it.layer(
  GitLabPullRequestCli.layer.pipe(
    Layer.provide(Layer.mock(GitLabCli.GitLabCli)({ execute: mockedExecute })),
  ),
);
function output(stdout: string) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated: false,
    stderrTruncated: false,
    stdoutInvalidUtf8: false,
  };
}
function callAt(index: number) {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}
function argsOfCall(index: number): ReadonlyArray<string> {
  return callAt(index).args;
}
afterEach(() => mockedExecute.mockReset());
layer("GitLabPullRequestCli review", (it) => {
  it.effect("sends a review as its comments, then its summary, then the verdict", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(
          output(
            JSON.stringify({
              iid: 7,
              title: "t",
              web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
              source_branch: "feat",
              target_branch: "main",
              created_at: "2026-07-01T00:00:00Z",
              updated_at: "2026-07-01T00:00:00Z",
              diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
            }),
          ),
        ),
      );
      mockedExecute.mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.submitReview({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        verdict: "approve",
        body: "Looks right.",
        comments: [
          {
            path: "src/b.ts",
            oldPath: "src/a.ts",
            position: { kind: "deleted", oldLine: 4 },
            body: "why remove?",
          },
        ],
      });

      expect(argsOfCall(0)[1]).toContain("merge_requests/7");
      expect(argsOfCall(1)[1]).toContain("/discussions");
      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({
        body: "why remove?",
        position: {
          base_sha: "base",
          head_sha: "head",
          start_sha: "start",
          position_type: "text",
          old_path: "src/a.ts",
          new_path: "src/b.ts",
          old_line: 4,
        },
      });
      expect(argsOfCall(2)[1]).toContain("/notes");
      expect(argsOfCall(3)[1]).toContain("/approve");
    }),
  );
  it.effect.each([
    { viewer: "the author who can push to the fork", username: "bilal", allowed: true },
    {
      viewer: "the author who turned them off",
      username: "bilal",
      allowCollaboration: false,
      allowed: true,
    },
    { viewer: "a target maintainer the fork lets push", username: "octocat", allowed: false },
    {
      viewer: "the author without push access",
      username: "bilal",
      pushToSourceBranch: false,
      allowed: false,
    },
    {
      viewer: "a viewer on a host that rejects the permission read",
      username: "bilal",
      rejected: true,
      allowed: false,
    },
    {
      viewer: "the author of a protected source branch",
      username: "bilal",
      sourceBranchProtected: true,
      allowed: false,
    },
    {
      viewer: "the author of a private fork",
      username: "bilal",
      sourceVisibility: "private",
      allowed: false,
    },
    {
      viewer: "the author targeting a private project",
      username: "bilal",
      targetVisibility: "private",
      allowed: false,
    },
  ])("reads a fork's maintainer edits and lets $viewer change them", (row) =>
    Effect.gen(function* () {
      const allowCollaboration = row.allowCollaboration ?? true;
      mockedExecute.mockImplementation(({ args }) =>
        Effect.succeed(
          output(
            args[1] === "graphql"
              ? JSON.stringify(
                  row.rejected === true
                    ? { errors: [{ message: "Field 'pushToSourceBranch' doesn't exist" }] }
                    : {
                        data: {
                          currentUser: { username: row.username },
                          project: {
                            visibility: row.targetVisibility ?? "public",
                            mergeRequest: {
                              author: { username: "bilal" },
                              userPermissions: {
                                pushToSourceBranch: row.pushToSourceBranch ?? true,
                              },
                              sourceBranchProtected: row.sourceBranchProtected ?? false,
                              sourceProject: { visibility: row.sourceVisibility ?? "public" },
                            },
                          },
                        },
                      },
                )
              : mergeRequestJson({
                  author,
                  source_project_id: 40,
                  target_project_id: 12,
                  allow_collaboration: allowCollaboration,
                }),
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const detail = yield* cli.getMergeRequestDetail({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        downstreamChecks: false,
      });

      expect(detail.maintainerCanModify).toBe(allowCollaboration);
      expect(detail.viewerCanEditMaintainerEdits).toBe(row.allowed);
    }),
  );

  it.effect("skips a fork's maintainer edits permission read when the caller opts out", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              mergeRequestJson({
                source_project_id: 40,
                target_project_id: 12,
                allow_collaboration: true,
              }),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(labelPermission));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const detail = yield* cli.getMergeRequestDetail({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        downstreamChecks: false,
        maintainerEdits: false,
      });

      expect(detail.maintainerCanModify).toBe(true);
      expect(detail.viewerCanEditMaintainerEdits).toBeUndefined();
      expect(mockedExecute).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect("sends maintainer edits as allow_collaboration", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.updateMergeRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        allowCollaboration: false,
      });

      expect(argsOfCall(0)).toContain("PUT");
      expect(JSON.parse(callAt(0).stdin ?? "")).toEqual({ allow_collaboration: false });
    }),
  );

  it.effect(
    "lists the requested reviewers first, even when the users page does not reach them",
    () =>
      Effect.gen(function* () {
        mockedExecute
          .mockReturnValueOnce(
            Effect.succeed(output(mergeRequestJson({ reviewers: [{ id: 42, username: "late" }] }))),
          )
          .mockReturnValueOnce(Effect.succeed(output(JSON.stringify([author, reviewer]))));
        const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

        const list = yield* cli.listReviewerCandidates({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
        });

        expect(
          list.candidates.map((candidate) => [
            candidate.login,
            candidate.id,
            candidate.isRequested,
          ]),
        ).toEqual([
          ["late", "42", true],
          [reviewer.username, "5", false],
        ]);
      }),
  );

  it.effect("marks a reviewer GitLab sent without a username as requested on the users page", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(output(mergeRequestJson({ reviewers: [{ id: 5, username: "" }] }))),
        )
        .mockReturnValueOnce(Effect.succeed(output(JSON.stringify([author, reviewer]))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const list = yield* cli.listReviewerCandidates({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      expect(list.candidates.map((candidate) => [candidate.id, candidate.isRequested])).toEqual([
        ["5", true],
      ]);
    }),
  );

  it.effect("asks GitLab to search the project's users when the menu has a query", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(mergeRequestJson({ reviewers: [reviewer, { id: 42, username: "unrelated" }] })),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output(JSON.stringify([reviewer]))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const list = yield* cli.listReviewerCandidates({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        query: "octo cat",
      });

      expect(list.candidates.map((candidate) => [candidate.login, candidate.isRequested])).toEqual([
        [reviewer.username, true],
      ]);
      expect(argsOfCall(1)[1]).toBe("projects/acme%2Fweb/users?per_page=100&search=octo%20cat");
    }),
  );

  it.effect("keeps a reviewer it cannot show when writing the set back", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(output(mergeRequestJson({ reviewers: [{ id: 3, username: "" }] }))),
        )
        .mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setReviewerRequest({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        reviewers: [{ id: "9" }],
        requested: true,
      });

      expect(JSON.parse(callAt(1).stdin ?? "")).toEqual({ reviewer_ids: [3, 9] });
    }),
  );

  it.effect("reports failure when no reference endpoint answers", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(
        Effect.fail(
          new GitLabCli.GitLabCliCommandError({
            operation: "execute",
            command: "glab",
            cwd: "/w",
            cause: null,
          }),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const result = yield* Effect.result(
        cli.searchProjectReferences({ cwd: "/w", repository: "acme/web" }),
      );
      expect(result._tag).toBe("Failure");
    }),
  );

  it.effect("keeps merge request references when the issue search fails", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation((input) =>
        JSON.stringify(input).includes("/issues?")
          ? Effect.fail(
              new GitLabCli.GitLabCliCommandError({
                operation: "execute",
                command: "glab",
                cwd: "/w",
                cause: null,
              }),
            )
          : Effect.succeed(output(JSON.stringify([{ iid: 5, title: "Ship it", state: "opened" }]))),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const page = yield* cli.searchProjectReferences({ cwd: "/w", repository: "acme/web" });
      expect(page.items.map((item) => item.reference)).toEqual(["!5"]);
    }),
  );
});

it("asks for a numeric reference's iid besides the recent issues and merge requests", () => {
  const recent = [
    ["order_by", "updated_at"],
    ["sort", "desc"],
  ];
  expect(GitLabPullRequestCli.referenceSearches("12")).toEqual([
    { kind: "issue", params: [["iids[]", "12"]] },
    { kind: "change-request", params: [["iids[]", "12"]] },
    { kind: "issue", params: recent },
    { kind: "change-request", params: recent },
  ]);
  expect(GitLabPullRequestCli.referenceSearches("crash")).toEqual([
    { kind: "issue", params: [...recent, ["search", "crash"], ["in", "title"]] },
    { kind: "change-request", params: [...recent, ["search", "crash"], ["in", "title"]] },
  ]);
  expect(GitLabPullRequestCli.referenceSearches("cr")).toEqual([
    { kind: "issue", params: recent },
    { kind: "change-request", params: recent },
  ]);
  expect(GitLabPullRequestCli.referenceSearches("12", "!")).toEqual([
    { kind: "change-request", params: [["iids[]", "12"]] },
    { kind: "change-request", params: recent },
  ]);
  expect(GitLabPullRequestCli.referenceSearches(undefined, "#")).toEqual([
    { kind: "issue", params: recent },
  ]);
});
