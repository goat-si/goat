import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";

function mergeRequestJson(overrides: Record<string, unknown>) {
  return JSON.stringify({
    iid: 7,
    title: "Merge request 7",
    web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
    source_branch: "feat/page",
    target_branch: "main",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    author: { id: 1, username: "bilal" },
    ...overrides,
  });
}

function commitJson(id: string) {
  return { id, title: "Commit", committed_date: "2026-07-01T00:00:00Z" };
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
layer("GitLabPullRequestCli revert", (it) => {
  it.effect("reverts a merged merge request onto a new branch and opens a merge request", () =>
    Effect.gen(function* () {
      const mergeCommit = "dac72fa101758a44b0068a23666559920a74478f";
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              mergeRequestJson({
                state: "merged",
                merge_commit_sha: mergeCommit,
                squash_commit_sha: "cb2d9f660ebe946e5056ae98993db5ea72b9bad1",
              }),
            ),
          ),
        )
        .mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.runMergeRequestAction({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        action: "revert",
      });

      expect(
        mockedExecute.mock.calls.map(([input]) => [
          input.args[1],
          input.stdin && JSON.parse(input.stdin),
        ]),
      ).toEqual([
        ["projects/acme%2Fweb/merge_requests/7", undefined],
        ["projects/acme%2Fweb/repository/branches", { branch: "revert-dac72fa1", ref: "main" }],
        [
          `projects/acme%2Fweb/repository/commits/${mergeCommit}/revert`,
          { branch: "revert-dac72fa1" },
        ],
        [
          "projects/acme%2Fweb/merge_requests",
          {
            source_branch: "revert-dac72fa1",
            target_branch: "main",
            title: 'Revert "Merge request 7"',
            description: "This reverts merge request !7",
            remove_source_branch: true,
          },
        ],
      ]);
    }),
  );

  it.effect.each([
    ["the revert conflicts", "/revert", "Failure"],
    ["opening the merge request fails", "/merge_requests", "Failure"],
    ["the request is interrupted", "/revert", "Interrupt"],
  ] as const)("deletes the revert branch when %s", ([, failingPath, outcome]) =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(({ args, cwd }) =>
        args[1]?.endsWith(failingPath) && args.includes("POST")
          ? outcome === "Interrupt"
            ? Effect.interrupt
            : Effect.fail(
                new GitLabCli.GitLabCliCommandError({
                  operation: "execute",
                  command: "glab",
                  cwd,
                  cause: new Error("GitLab rejected the write"),
                }),
              )
          : Effect.succeed(
              output(
                mergeRequestJson({
                  state: "merged",
                  merge_commit_sha: null,
                  squash_commit_sha: "abc12345ff",
                }),
              ),
            ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const exit = yield* Effect.exit(
        cli.runMergeRequestAction({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          action: "revert",
        }),
      );

      expect(exit._tag).toBe("Failure");
      expect(mockedExecute.mock.calls.at(-1)?.[0].args.slice(1, 4)).toEqual([
        "projects/acme%2Fweb/repository/branches/revert-abc12345",
        "--method",
        "DELETE",
      ]);
    }),
  );

  it.effect.each([
    ["reverts the sole commit of", [commitJson("1111111122")], "revert-11111111"],
    [
      "refuses to revert several commits of",
      [commitJson("1111111122"), commitJson("2222222233")],
      "GitLabRevertUnavailableError",
    ],
  ] as const)("%s a fast-forward merge without squash", ([, commits, expected]) =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              mergeRequestJson({
                state: "merged",
                merge_commit_sha: null,
                squash_commit_sha: null,
              }),
            ),
          ),
        )
        .mockReturnValueOnce(Effect.succeed(output(JSON.stringify(commits))))
        .mockReturnValue(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const result = yield* Effect.result(
        cli.runMergeRequestAction({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          action: "revert",
        }),
      );

      expect(argsOfCall(1)[1]).toBe("projects/acme%2Fweb/merge_requests/7/commits?per_page=2");
      if (expected === "GitLabRevertUnavailableError") {
        expect(result).toMatchObject({ _tag: "Failure", failure: { _tag: expected } });
      } else {
        expect(JSON.parse(callAt(2).stdin ?? "")).toEqual({ branch: expected, ref: "main" });
      }
    }),
  );

  it.effect("refuses to revert a merge request that is not merged before any write", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(
            output(
              mergeRequestJson({
                state: "opened",
                merge_commit_sha: null,
                squash_commit_sha: null,
              }),
            ),
          ),
        )
        .mockReturnValue(Effect.succeed(output(JSON.stringify([commitJson("1111111122")]))));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const result = yield* Effect.result(
        cli.runMergeRequestAction({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          action: "revert",
        }),
      );

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "GitLabRevertUnavailableError", reason: "not-merged" },
      });
      expect(mockedExecute).toHaveBeenCalledTimes(1);
    }),
  );
});
