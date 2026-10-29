import { afterEach, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";
import * as GitLabPullRequestProvider from "./GitLabPullRequestProvider.ts";

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
function mergeRequestJson(overrides: Record<string, unknown>): string {
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
afterEach(() => {
  mockedExecute.mockReset();
});
layer("GitLab pinned merge", (it) => {
  it.effect("refuses a pinned automatic merge before invoking GitLab", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValue(Effect.succeed(output("")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const result = yield* Effect.result(
        cli.runMergeRequestAction({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          action: "enable-auto-merge",
          headSha: "reviewed-head",
        }),
      );
      expect(result).toMatchObject({ _tag: "Failure" });
      const provider = yield* GitLabPullRequestProvider.make;
      const error = yield* Effect.flip(
        provider.runAction({
          cwd: "/w",
          repository: "acme/web",
          host: "gitlab.com",
          number: 7,
          action: "enable-auto-merge",
          headSha: "reviewed-head",
        }),
      );
      expect(error).toMatchObject({ reason: "pinned-auto-merge" });
      expect(mockedExecute).not.toHaveBeenCalled();
    }),
  );
  it.effect.each(["merge"] as const)("passes the reviewed head to GitLab for %s", (action) =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(({ args }) =>
        Effect.succeed(
          output(
            args[0] === "api"
              ? mergeRequestJson({
                  diff_refs: { base_sha: "base", head_sha: "current-head", start_sha: "start" },
                })
              : "",
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      yield* cli.runMergeRequestAction({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        action,
        headSha: "reviewed-head",
      });
      expect(mockedExecute.mock.calls.map(([input]) => input.args)).toEqual([
        [
          "mr",
          "merge",
          "7",
          "--repo",
          "acme/web",
          `--auto-merge=${action === "merge" ? "false" : "true"}`,
          "--yes",
          "--sha",
          "reviewed-head",
        ],
      ]);
    }),
  );

  it.effect("refuses a pinned rebase before changing the source branch", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(({ args }) =>
        Effect.succeed(
          output(
            args[0] === "api"
              ? mergeRequestJson({
                  diff_refs: { base_sha: "base", head_sha: "current-head", start_sha: "start" },
                })
              : "",
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const result = yield* Effect.result(
        cli.runMergeRequestAction({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          action: "merge",
          mergeMethod: "rebase",
          headSha: "reviewed-head",
        }),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "GitLabPinnedRebaseError" },
      });
      const provider = yield* GitLabPullRequestProvider.make;
      const error = yield* Effect.flip(
        provider.runAction({
          cwd: "/w",
          repository: "acme/web",
          host: "gitlab.com",
          number: 7,
          action: "merge",
          mergeMethod: "rebase",
          headSha: "reviewed-head",
        }),
      );
      expect(error).toMatchObject({ reason: "pinned-head-refused" });
      expect(mockedExecute).not.toHaveBeenCalled();
    }),
  );
});
