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
