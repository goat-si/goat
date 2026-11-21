import { assert, expect, it, vi } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { ChildProcessSpawner } from "effect/process";

import * as GitLabCli from "./GitLabCli.ts";
import * as GitLabPullRequestCli from "./GitLabPullRequestCli.ts";

const mockedExecute = vi.fn<GitLabCli.GitLabCli["Service"]["execute"]>();

const layer = it.layer(
  GitLabPullRequestCli.layer.pipe(
    Layer.provide(
      Layer.mock(GitLabCli.GitLabCli)({
        execute: mockedExecute,
      }),
    ),
  ),
);

function output(stdout: string, stdoutTruncated = false, stdoutInvalidUtf8 = false) {
  return {
    exitCode: ChildProcessSpawner.ExitCode(0),
    stdout,
    stderr: "",
    stdoutTruncated,
    stderrTruncated: false,
    stdoutInvalidUtf8,
  };
}

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

layer("GitLabPullRequestCli.list output", (it) => {
  it.effect("reads a page of merge requests larger than the VCS default output limit", () =>
    Effect.gen(function* () {
      const vcsDefaultMaxOutputBytes = 1_000_000;
      const rows = (JSON.parse(mergeRequests(100, 1)) as ReadonlyArray<object>).map((row) => ({
        ...row,
        description: "x".repeat(20_000),
      }));
      const response = JSON.stringify(rows);
      expect(Buffer.byteLength(response)).toBeGreaterThan(vcsDefaultMaxOutputBytes);
      mockedExecute.mockImplementationOnce(({ maxOutputBytes = vcsDefaultMaxOutputBytes }) =>
        Effect.succeed(
          maxOutputBytes >= Buffer.byteLength(response)
            ? output(response)
            : output(response.slice(0, maxOutputBytes), true),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const batch = yield* cli.listMergeRequests({
        cwd: "/w",
        repository: "acme/web",
        state: "open",
        involvement: "all",
        viewer: "bilal",
        limit: 99,
      });

      assert.strictEqual(batch.items.length, 99);
      assert.isTrue(batch.truncated);
    }),
  );
});
