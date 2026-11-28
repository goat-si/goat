import { expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
