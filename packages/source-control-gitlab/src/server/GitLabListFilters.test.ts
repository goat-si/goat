import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
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
function argsOfCall(index: number) {
  return callAt(index).args;
}
afterEach(() => mockedExecute.mockReset());
function mergeRequests(count: number, firstNumber: number): string {
  return JSON.stringify(
    Array.from({ length: count }, (_, index) => ({
      iid: firstNumber + index,
      title: `Merge request ${firstNumber + index}`,
      web_url: `https://gitlab.com/acme/web/-/merge_requests/${firstNumber + index}`,
      source_branch: "feat/page",
      target_branch: "main",
      created_at: "2026-07-01T00:00:00Z",
      updated_at: "2026-07-02T00:00:00Z",
    })),
  );
}

function graphqlListPage(
  numbers: ReadonlyArray<number>,
  pageInfo: { readonly hasNextPage: boolean; readonly endCursor: string | null },
): string {
  return JSON.stringify({
    data: {
      metadata: { enterprise: true },
      project: {
        mergeRequests: {
          pageInfo,
          nodes: numbers.map((number) => ({
            iid: String(number),
            title: `Merge request ${number}`,
            webUrl: `https://gitlab.com/acme/web/-/merge_requests/${number}`,
            createdAt: "2026-07-01T00:00:00Z",
            updatedAt: "2026-07-02T00:00:00Z",
            sourceBranch: "feat/page",
            targetBranch: "main",
            approved: true,
            approvedBy: { nodes: [{ username: "julius" }] },
          })),
        },
      },
    },
  });
}

function graphqlRequestOf(index: number) {
  return JSON.parse(callAt(index).stdin ?? "{}") as {
    readonly query: string;
    readonly variables: Record<string, unknown>;
  };
}

layer("GitLab list filters", (it) => {
  it.effect("narrows by approval only where GitLab returns every row the decision keeps", () =>
    Effect.gen(function* () {
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const reviews = ["none", "review-required", "changes-requested"] as const;
      for (const review of reviews) {
        mockedExecute.mockReturnValueOnce(Effect.succeed(output(mergeRequests(1, 1))));
        yield* cli.listMergeRequests({
          cwd: "/w",
          repository: "acme/web",
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
          filters: { review },
        });
      }

      const sent = reviews.map((_, call) => {
        const params = new URLSearchParams((argsOfCall(call)[1] ?? "").split("?")[1]);
        return [params.get("approved_by_ids[]"), params.get("approved_by_usernames[]")];
      });
      expect(sent).toEqual([
        ["None", null],
        [null, null],
        [null, null],
      ]);
    }),
  );

  it.effect(
    "lists through GraphQL with the filters GitLab narrows there, declaring only those",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValue(
          Effect.succeed(output(graphqlListPage([1], { hasNextPage: false, endCursor: null }))),
        );
        const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

        yield* cli.listMergeRequests({
          cwd: "/w",
          repository: "acme/web",
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
          query: " page ",
          graphql: true,
          cursor: {
            updatedBefore: "2026-07-03T00:00:00Z",
            delivered: 10,
            resumeAfter: "eyJpZCI6IjEifQ",
          },
          filters: {
            labels: [["bug"], ["size:S", "size:XS"]],
            excludedLabels: ["wontfix"],
            author: "octocat",
            draft: "hide",
            review: "changes-requested",
          },
        });

        const { query, variables } = graphqlRequestOf(0);
        expect(variables).toEqual({
          fullPath: "acme/web",
          first: 10,
          after: "eyJpZCI6IjEifQ",
          state: "opened",
          authorUsername: "octocat",
          search: "page",
          labels: ["bug"],
          draft: false,
          reviewStates: ["REQUESTED_CHANGES"],
          notLabels: ["wontfix"],
        });
        expect(query).toContain("reviewStates: $reviewStates");
        expect(query).toContain("not: { labels: $notLabels }");
        expect(query).not.toContain("$approvedBy");

        // Beside a reviewer, GitLab would match only that reviewer's own state.
        yield* cli.listMergeRequests({
          cwd: "/w",
          repository: "acme/web",
          state: "open",
          involvement: "reviewing",
          viewer: "bilal",
          limit: 10,
          graphql: true,
          filters: { review: "changes-requested" },
        });
        expect(graphqlRequestOf(1).variables).toMatchObject({ reviewerUsername: "bilal" });
        expect(graphqlRequestOf(1).variables).not.toHaveProperty("reviewStates");
      }),
  );

  it.effect("walks GraphQL pages by GitLab's cursor and hands the last one back", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(output(graphqlListPage([1, 2], { hasNextPage: true, endCursor: "c1" }))),
        )
        .mockReturnValueOnce(
          Effect.succeed(output(graphqlListPage([3], { hasNextPage: true, endCursor: "c2" }))),
        );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 3,
        graphql: true,
        filters: { review: "approved" },
      });

      expect(batch).toMatchObject({ truncated: true, cursorAdvance: 3, resumeAfter: "c2" });
      expect(batch.items.map((item) => item.number)).toEqual([1, 2, 3]);
      expect(batch.listStates?.get(3)).toEqual({ reviewDecision: "approved", checksState: null });
      expect([0, 1].map((call) => graphqlRequestOf(call).variables)).toMatchObject([
        { first: 3, after: null, approvedBy: ["Any"] },
        { first: 1, after: "c1" },
      ]);
    }),
  );

  it.effect("reads REST for a REST cursor, and when a first GraphQL read or command fails", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequests(1, 1))))
        .mockReturnValueOnce(
          Effect.succeed(
            output(JSON.stringify({ errors: [{ message: "Field 'search' doesn't exist" }] })),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output(mergeRequests(1, 1))))
        .mockReturnValueOnce(Effect.succeed(output(JSON.stringify({ errors: [] }))))
        .mockReturnValueOnce(
          Effect.fail(
            new GitLabCli.GitLabCliCommandError({
              operation: "execute",
              command: "glab",
              cwd: "/w",
              cause: new Error("502 Bad Gateway"),
            }),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output(mergeRequests(1, 2))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const list = (cursor?: { updatedBefore: string; delivered: number; resumeAfter?: string }) =>
        cli.listMergeRequests({
          cwd: "/w",
          repository: "acme/web",
          state: "open",
          involvement: "all",
          viewer: "bilal",
          limit: 10,
          // A cursor, not the host's current answer, picks the API.
          graphql: cursor?.resumeAfter === undefined,
          ...(cursor === undefined ? {} : { cursor }),
        });

      yield* list({ updatedBefore: "2026-07-03T00:00:00Z", delivered: 10 });
      const fellBack = yield* list();
      // A resumed GraphQL read stays on GraphQL and fails, since REST would read `delivered` as an offset.
      const resumed = yield* Effect.result(
        list({ updatedBefore: "2026-07-03T00:00:00Z", delivered: 10, resumeAfter: "c1" }),
      );
      const commandFailed = yield* list();

      expect(fellBack.items.map((item) => item.number)).toEqual([1]);
      expect(fellBack).not.toHaveProperty("resumeAfter");
      expect(mockedExecute.mock.calls.map(([request]) => request.args[1]?.split("?")[0])).toEqual([
        "projects/acme%2Fweb/merge_requests",
        "graphql",
        "projects/acme%2Fweb/merge_requests",
        "graphql",
        "graphql",
        "projects/acme%2Fweb/merge_requests",
      ]);
      expect(commandFailed.items.map((item) => item.number)).toEqual([2]);
      expect(resumed).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "GitLabMergeRequestReadError" },
      });
    }),
  );
});
