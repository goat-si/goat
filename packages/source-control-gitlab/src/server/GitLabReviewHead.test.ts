import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";
import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";

it.effect("sends the reviewed head to GitLab when approving", () =>
  Effect.gen(function* () {
    const execute = vi.fn<GitLabCli.GitLabCli["Service"]["execute"]>(() =>
      Effect.succeed({
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: "{}",
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
      }),
    );
    const cli = yield* GitLabPullRequestCli.make.pipe(
      Effect.provide(Layer.mock(GitLabCli.GitLabCli)({ execute })),
    );
    const approval = {
      cwd: "/w",
      repository: "acme/web",
      number: 7,
      verdict: "approve" as const,
      body: "",
      comments: [],
    };
    yield* cli.submitReview({ ...approval, expectedHeadSha: "0a1b2c3d4e5f" });
    expect(execute.mock.calls[0]?.[0].stdin).toBe('{"sha":"0a1b2c3d4e5f"}');
    yield* cli.submitReview(approval);
    expect(execute.mock.calls[1]?.[0].stdin).toBeUndefined();
  }),
);

it.effect("rejects a stale review head before requesting changes on GitLab", () =>
  Effect.gen(function* () {
    const execute = vi.fn<GitLabCli.GitLabCli["Service"]["execute"]>(() =>
      Effect.succeed({
        exitCode: ChildProcessSpawner.ExitCode(0),
        stdout: JSON.stringify({
          diff_refs: {
            base_sha: "111111111111",
            head_sha: "222222222222",
            start_sha: "000000000000",
          },
        }),
        stderr: "",
        stdoutTruncated: false,
        stderrTruncated: false,
        stdoutInvalidUtf8: false,
      }),
    );
    const cli = yield* GitLabPullRequestCli.make.pipe(
      Effect.provide(Layer.mock(GitLabCli.GitLabCli)({ execute })),
    );
    const exit = yield* cli
      .submitReview({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        verdict: "request-changes",
        body: "Needs fixes",
        expectedHeadSha: "0a1b2c3d4e5f",
        comments: [
          {
            path: "src/app.ts",
            body: "Check this line",
            position: { kind: "added", newLine: 10 },
          },
        ],
      })
      .pipe(Effect.exit);

    expect(Exit.isFailure(exit)).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0].args).not.toContain("--method");
  }),
);
