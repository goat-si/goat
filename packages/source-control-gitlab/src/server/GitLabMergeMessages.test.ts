import { afterEach, expect, it, vi } from "@effect/vitest";
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
function mergeRequestJson(overrides: Record<string, unknown>) {
  return JSON.stringify({
    iid: 7,
    title: "Merge request 7",
    web_url: "https://gitlab.com/acme/web/-/merge_requests/7",
    source_branch: "feat/page",
    target_branch: "main",
    created_at: "2026-07-01T00:00:00Z",
    updated_at: "2026-07-02T00:00:00Z",
    ...overrides,
  });
}
afterEach(() => mockedExecute.mockReset());
layer("GitLab merge messages", (it) => {
  it.effect.each([
    {
      mergeMethod: "squash",
      squashOnMerge: false,
      squash: "Add thing\n\nCo-authored-by: Codex <noreply@openai.com>",
      flags: [
        "--squash",
        "--sha",
        "head",
        "--message",
        "Merge branch 'feature' into 'main'\n\nAdd thing\n\nCo-authored-by: Ada <ada@example.com>",
        "--squash-message",
        "Add thing",
      ],
    },
    {
      mergeMethod: "merge",
      squashOnMerge: false,
      squash: "Add thing\n\nCo-authored-by: Codex <noreply@openai.com>",
      flags: [
        "--sha",
        "head",
        "--message",
        "Merge branch 'feature' into 'main'\n\nAdd thing\n\nCo-authored-by: Ada <ada@example.com>",
      ],
    },
    {
      mergeMethod: "merge",
      squashOnMerge: true,
      squash: "Add thing\n\nCo-authored-by: Codex <noreply@openai.com>",
      flags: [
        "--sha",
        "head",
        "--message",
        "Merge branch 'feature' into 'main'\n\nAdd thing\n\nCo-authored-by: Ada <ada@example.com>",
        "--squash",
        "--squash-message",
        "Add thing",
      ],
    },
    {
      mergeMethod: "squash",
      squashOnMerge: false,
      squash: "Co-authored-by: Codex <noreply@openai.com>",
      flags: [
        "--squash",
        "--sha",
        "head",
        "--message",
        "Merge branch 'feature' into 'main'\n\nAdd thing\n\nCo-authored-by: Ada <ada@example.com>",
        "--squash-message",
        "Add thing",
      ],
    },
  ] as const)(
    "removes agent credits from GitLab's default messages for a $mergeMethod (squash on merge: $squashOnMerge)",
    ({ mergeMethod, squashOnMerge, squash, flags }) =>
      Effect.gen(function* () {
        const credits =
          "Co-authored-by: Ada <ada@example.com>\nCo-authored-by: Claude <noreply@anthropic.com>";
        mockedExecute.mockImplementation(({ args }) =>
          Effect.succeed(
            output(
              args[1] === "graphql"
                ? JSON.stringify({
                    data: {
                      project: {
                        mergeRequest: {
                          title: "Add thing",
                          squashOnMerge,
                          defaultMergeCommitMessage: `Merge branch 'feature' into 'main'\n\nAdd thing\n\n${credits}`,
                          defaultSquashCommitMessage: squash,
                        },
                      },
                    },
                  })
                : args[0] === "api"
                  ? mergeRequestJson({
                      diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
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
          action: "merge",
          mergeMethod,
          removeAgentCreditsOnMerge: true,
        });

        expect(mockedExecute.mock.calls.at(-1)?.[0].args).toEqual([
          "mr",
          "merge",
          "7",
          "--repo",
          "acme/web",
          "--auto-merge=false",
          "--yes",
          ...flags,
        ]);
      }),
  );

  it.effect("keeps GitLab's merge messages when they carry no agent credits", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(({ args }) =>
        Effect.succeed(
          output(
            args[1] === "graphql"
              ? JSON.stringify({
                  data: {
                    project: {
                      mergeRequest: {
                        defaultMergeCommitMessage: "Merge branch 'feature' into 'main'",
                        defaultSquashCommitMessage: "Add thing",
                      },
                    },
                  },
                })
              : args[0] === "api"
                ? mergeRequestJson({
                    diff_refs: { base_sha: "base", head_sha: "head", start_sha: "start" },
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
        action: "enable-auto-merge",
        mergeMethod: "squash",
        removeAgentCreditsOnMerge: true,
      });

      expect(mockedExecute.mock.calls.at(-1)?.[0].args).toEqual([
        "mr",
        "merge",
        "7",
        "--repo",
        "acme/web",
        "--auto-merge=true",
        "--yes",
        "--squash",
        "--sha",
        "head",
      ]);
    }),
  );
});
