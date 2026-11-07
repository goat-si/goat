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
});
