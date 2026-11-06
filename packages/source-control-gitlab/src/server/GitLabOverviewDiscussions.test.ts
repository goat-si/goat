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
afterEach(() => mockedExecute.mockReset());
layer("GitLab overview discussions", (it) => {
  it.effect(
    "reads a positioned discussion as a thread and an open overview discussion as a finding",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockReturnValueOnce(
          Effect.succeed(
            output(
              JSON.stringify([
                {
                  id: "abc123",
                  notes: [
                    {
                      id: 1,
                      body: "rename this",
                      author: { username: "bilal", avatar_url: "https://avatars/b.png" },
                      created_at: "2026-07-01T00:00:00Z",
                      resolvable: true,
                      resolved: true,
                      position: {
                        position_type: "text",
                        new_path: "src/a.ts",
                        old_path: "src/a.ts",
                        new_line: 12,
                        old_line: null,
                        base_sha: "base",
                        start_sha: "start",
                        head_sha: "head",
                      },
                    },
                    {
                      id: 2,
                      body: "done",
                      author: { username: "alex" },
                      created_at: "2026-07-01T01:00:00Z",
                    },
                  ],
                },
                { id: "def456", notes: [{ id: 3, body: "ship it", created_at: "2026-07-01Z" }] },
                {
                  id: "ghi789",
                  notes: [
                    {
                      id: 4,
                      body: "mention the new flag in the README",
                      created_at: "2026-07-01T02:00:00Z",
                      resolvable: true,
                      resolved: false,
                    },
                    {
                      id: 5,
                      body: "will do",
                      created_at: "2026-07-01T03:00:00Z",
                      resolvable: true,
                      resolved: false,
                    },
                  ],
                },
                {
                  id: "jkl012",
                  notes: [
                    {
                      id: 6,
                      body: "already addressed",
                      created_at: "2026-07-01T04:00:00Z",
                      resolvable: true,
                      resolved: true,
                    },
                  ],
                },
                {
                  id: "file789",
                  notes: [
                    {
                      id: 7,
                      body: "split this file",
                      created_at: "2026-07-01Z",
                      position: {
                        position_type: "file",
                        new_path: "src/b.ts",
                        old_path: "src/b.ts",
                        new_line: null,
                        old_line: null,
                      },
                    },
                  ],
                },
                {
                  id: "img012",
                  notes: [
                    {
                      id: 8,
                      body: "logo is blurry",
                      created_at: "2026-07-01Z",
                      position: {
                        position_type: "image",
                        new_path: "logo.png",
                        old_path: "logo.png",
                        new_line: null,
                        old_line: null,
                      },
                    },
                  ],
                },
              ]),
            ),
          ),
        );
        const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

        const { threads, diffRefsByThreadId, overviewFindingIds } = yield* cli.listDiscussions({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
        });

        expect(overviewFindingIds).toEqual(["4"]);
        expect(threads.map(({ id, path, line, side }) => ({ id, path, line, side }))).toEqual([
          { id: "abc123", path: "src/a.ts", line: 12, side: "right" },
          { id: "file789", path: "src/b.ts", line: null, side: "right" },
          { id: "img012", path: "logo.png", line: null, side: "right" },
        ]);
        expect([...diffRefsByThreadId]).toEqual([
          ["abc123", { baseSha: "base", startSha: "start", headSha: "head" }],
        ]);
        expect(threads[0]).toMatchObject({ isResolved: true });
        assert.strictEqual(threads[0]?.comments.length, 2);
      }),
  );
});
