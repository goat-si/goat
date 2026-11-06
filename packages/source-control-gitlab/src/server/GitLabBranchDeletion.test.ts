import { afterEach, assert, expect, it, vi } from "@effect/vitest";
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
function callAt(index: number) {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}
function argsOfCall(index: number) {
  return callAt(index).args;
}
afterEach(() => mockedExecute.mockReset());
const labelPermission = output(
  JSON.stringify({
    data: { project: { mergeRequest: { userPermissions: { adminMergeRequest: false } } } },
  }),
);
function sourceBranchJson(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    data: {
      project: {
        mergeRequest: {
          state: "merged",
          sourceBranch: "feat/page",
          diffHeadSha: "head",
          sourceProject: { fullPath: "acme/web" },
          userPermissions: { removeSourceBranch: true },
          ...overrides,
        },
      },
    },
  });
}

layer("GitLab branch deletion", (it) => {
  it.effect.each([
    { answer: sourceBranchJson({}), expected: true },
    { answer: "not json", expected: false },
  ])("asks GitLab whether a merged merge request's branch can be deleted", ({ answer, expected }) =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(mergeRequestJson({ state: "merged" }))))
        .mockReturnValueOnce(Effect.succeed(labelPermission))
        .mockReturnValueOnce(Effect.succeed(output(answer)));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const detail = yield* cli.getMergeRequestDetail({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
      });

      expect(detail.viewerCanDeleteBranch).toBe(expected);
      expect(argsOfCall(2)).toContain("graphql");
    }),
  );

  it.effect("keeps the branch when GitLab cannot atomically check its head", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(
          Effect.succeed(output(sourceBranchJson({ sourceProject: { fullPath: "fork/web" } }))),
        )
        .mockReturnValueOnce(
          Effect.succeed(output(JSON.stringify({ default: false, commit: { id: "head" } }))),
        )
        .mockReturnValueOnce(Effect.succeed(output("")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const result = yield* Effect.result(
        cli.runMergeRequestAction({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          action: "delete-branch",
        }),
      );
      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "GitLabBranchDeletionRefusedError", reason: "cannot-verify" },
      });
      if (result._tag === "Failure")
        expect(result.failure.detail).toBe("Branch kept: cannot verify it is unchanged.");
      expect(mockedExecute.mock.calls.some(([call]) => call.args.includes("DELETE"))).toBe(false);
    }),
  );

  it.effect("reports why the source branch was kept through the provider", () =>
    Effect.gen(function* () {
      mockedExecute
        .mockReturnValueOnce(Effect.succeed(output(sourceBranchJson({}))))
        .mockReturnValueOnce(
          Effect.succeed(output(JSON.stringify({ default: false, commit: { id: "head" } }))),
        );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      const provider = yield* GitLabPullRequestProvider.make.pipe(
        Effect.provideService(GitLabPullRequestCli.GitLabPullRequestCli, cli),
      );
      const error = yield* provider
        .runAction({
          cwd: "/w",
          host: "gitlab.com",
          repository: "acme/web",
          number: 7,
          action: "delete-branch",
        })
        .pipe(Effect.flip);
      expect(error.detail).toBe("Branch kept: cannot verify it is unchanged.");
      expect(mockedExecute.mock.calls.some(([call]) => call.args.includes("DELETE"))).toBe(false);
    }),
  );

  it.effect.each([
    { reason: "open", source: { state: "opened" }, branch: undefined },
    { reason: "open", source: { state: "locked" }, branch: undefined },
    {
      reason: "not-allowed",
      source: { userPermissions: { removeSourceBranch: false } },
      branch: undefined,
    },
    { reason: "default-branch", source: {}, branch: { default: true, commit: { id: "head" } } },
    { reason: "head-changed", source: {}, branch: { default: false, commit: { id: "newer" } } },
  ])("refuses to delete the source branch when it is $reason", ({ reason, source, branch }) =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output(sourceBranchJson(source))));
      if (branch !== undefined) {
        mockedExecute.mockReturnValueOnce(Effect.succeed(output(JSON.stringify(branch))));
      }
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const error = yield* cli
        .runMergeRequestAction({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
          action: "delete-branch",
        })
        .pipe(Effect.flip);

      expect(error).toMatchObject({ _tag: "GitLabBranchDeletionRefusedError", reason });
      expect(mockedExecute).toHaveBeenCalledTimes(branch === undefined ? 1 : 2);
    }),
  );
});
