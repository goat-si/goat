import { afterEach, assert, expect, it, vi } from "@effect/vitest";
import { VcsProcessExitError } from "@goat/contracts";
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
function callAt(index: number) {
  const call = mockedExecute.mock.calls[index];
  assert.isDefined(call);
  return call[0];
}
function argsOfCall(index: number) {
  return callAt(index).args;
}
afterEach(() => mockedExecute.mockReset());
layer("GitLab labels", (it) => {
  it.effect.each([
    {
      answer: JSON.stringify({
        data: { project: { mergeRequest: { userPermissions: { adminMergeRequest: true } } } },
      }),
      expected: true,
    },
    { answer: JSON.stringify({ errors: [{ message: "Field unknown" }] }), expected: false },
  ])("reads merge and label permissions without reading the trigger jobs", ({ answer, expected }) =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(({ args }) =>
        Effect.succeed(
          output(
            args[1] === "graphql"
              ? answer
              : mergeRequestJson({
                  head_pipeline: { id: 31, project_id: 12, status: "success" },
                  user: { can_merge: false },
                }),
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const detail = yield* cli.getMergeRequestDetail({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        downstreamChecks: false,
      });

      expect(detail.viewerCanMerge).toBe(false);
      expect(detail.viewerCanEditLabels).toBe(expected);
      expect(mockedExecute).toHaveBeenCalledTimes(2);
    }),
  );

  it.effect(
    "offers the project's and its groups' labels, marking those already applied, and keeps an applied label past the page",
    () =>
      Effect.gen(function* () {
        mockedExecute.mockImplementation(({ args }) =>
          Effect.succeed(
            output(
              args[1]?.includes("/labels?")
                ? JSON.stringify([
                    { name: "bug", color: "#d9534f", description: "Something is broken" },
                    { name: "docs", color: null, description: null },
                    { name: "legacy", color: null, description: null, archived: true },
                    { name: "wontfix", color: null, description: null, archived: true },
                  ])
                : mergeRequestJson({ labels: ["bug", "wontfix", "stale"] }),
            ),
          ),
        );
        const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

        const list = yield* cli.listLabelCandidates({
          cwd: "/w",
          repository: "acme/web",
          number: 7,
        });

        expect(
          mockedExecute.mock.calls
            .map(([call]) => call.args[1])
            .find((path) => path?.includes("/labels?")),
        ).toBe("projects/acme%2Fweb/labels?per_page=100&include_ancestor_groups=true");
        expect(list).toEqual({
          candidates: [
            { name: "stale", color: null, description: null, isApplied: true },
            { name: "bug", color: "#d9534f", description: "Something is broken", isApplied: true },
            { name: "docs", color: null, description: null, isApplied: false },
            { name: "wontfix", color: null, description: null, isApplied: true },
          ],
          truncated: false,
        });
      }),
  );

  it.effect("adds labels the project has in one write", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(({ args }) =>
        Effect.succeed(
          output(
            args.includes("PUT")
              ? "{}"
              : JSON.stringify({
                  name: decodeURIComponent(args[1]?.split("/labels/")[1]?.split("?")[0] ?? ""),
                  color: null,
                }),
          ),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setLabels({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        labels: ["bug", "docs"],
        applied: true,
      });

      const write = mockedExecute.mock.calls.find(([call]) => call.args.includes("PUT"))?.[0];
      assert.isDefined(write);
      expect(write.args[1]).toBe("projects/acme%2Fweb/merge_requests/7");
      expect(JSON.parse(write.stdin ?? "")).toEqual({ add_labels: "bug,docs" });
      expect(argsOfCall(0)[1]).toBe("projects/acme%2Fweb/labels/bug?include_ancestor_groups=true");
    }),
  );

  it.effect("refuses to add a label the project lacks, since GitLab would create it", () =>
    Effect.gen(function* () {
      mockedExecute.mockImplementation(() =>
        Effect.fail(
          new GitLabCli.GitLabCliCommandError({
            operation: "execute",
            command: "glab",
            cwd: "/w",
            cause: new VcsProcessExitError({
              operation: "GitLabCli.execute",
              command: "glab",
              cwd: "/w",
              exitCode: 1,
              detail: "404 Label Not Found",
              failureKind: "not-found",
            }),
          }),
        ),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      const result = yield* cli
        .setLabels({ cwd: "/w", repository: "acme/web", number: 7, labels: ["bug"], applied: true })
        .pipe(Effect.flip);

      expect(result).toMatchObject({ _tag: "GitLabUnknownLabelError", labels: ["bug"] });
      expect(argsOfCall(0)[1]).toBe("projects/acme%2Fweb/labels/bug?include_ancestor_groups=true");
      expect(mockedExecute.mock.calls.some(([call]) => call.args.includes("PUT"))).toBe(false);
    }),
  );

  it.effect("removes labels without looking them up", () =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(Effect.succeed(output("{}")));
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;

      yield* cli.setLabels({
        cwd: "/w",
        repository: "acme/web",
        number: 7,
        labels: ["bug"],
        applied: false,
      });

      expect(mockedExecute).toHaveBeenCalledTimes(1);
      expect(JSON.parse(callAt(0).stdin ?? "")).toEqual({ remove_labels: "bug" });
    }),
  );
  it.effect.each([
    ["th", "projects/acme%2Fweb/users?per_page=100"],
    ["tho", "projects/acme%2Fweb/users?per_page=100&search=tho"],
  ] as const)("searches GitLab users from three characters (%s)", ([search, path]) =>
    Effect.gen(function* () {
      mockedExecute.mockReturnValueOnce(
        Effect.succeed(output(JSON.stringify([{ id: 1, username: "sam" }]))),
      );
      const cli = yield* GitLabPullRequestCli.GitLabPullRequestCli;
      yield* cli.listProjectUsers({ cwd: "/w", repository: "acme/web", search });
      expect(argsOfCall(0)[1]).toBe(path);
    }),
  );
});
