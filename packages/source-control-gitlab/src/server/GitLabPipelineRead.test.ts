import { afterEach, assert, describe, expect, it, vi } from "@effect/vitest";
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
const labelPermission = output(
  JSON.stringify({
    data: { project: { mergeRequest: { userPermissions: { adminMergeRequest: false } } } },
  }),
);
layer("GitLab pipeline stages", (it) => {
  describe("the head pipeline's stages", () => {
    const pipeline = {
      id: 9,
      project_id: 12,
      status: "failed",
      web_url: "https://gitlab.com/acme/web/-/pipelines/9",
      source: "merge_request_event",
    };
    const stages = JSON.stringify({
      data: {
        project: {
          mergeRequest: {
            headPipeline: {
              path: "/acme/web/-/pipelines/9",
              stages: {
                nodes: [
                  { name: "build", status: "success", detailedStatus: { label: "passed" } },
                  {
                    name: "test",
                    status: "failed",
                    jobs: {
                      nodes: [{ name: "unit", status: "FAILED", webPath: "/acme/web/-/jobs/3" }],
                    },
                  },
                  {
                    name: "deploy",
                    status: "success",
                    jobs: {
                      nodes: [
                        // A trigger job without `strategy: depend` succeeds whatever its child does.
                        {
                          name: "child-pipeline",
                          status: "SUCCESS",
                          webPath: null,
                          downstreamPipeline: {
                            status: "FAILED",
                            path: "/acme/child/-/pipelines/10",
                          },
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
        },
      },
    });

    function answer(graphql: Effect.Effect<ReturnType<typeof output>, GitLabCli.GitLabCliError>) {
      mockedExecute.mockImplementation((request) =>
        request.args[1] === "graphql"
          ? request.stdin?.includes("adminMergeRequest")
            ? Effect.succeed(labelPermission)
            : graphql
          : request.args[1]?.includes("/bridges")
            ? Effect.succeed(
                output(
                  JSON.stringify([
                    {
                      name: "child-pipeline",
                      status: "success",
                      downstream_pipeline: {
                        status: "failed",
                        web_url: "https://gitlab.com/acme/child/-/pipelines/10",
                      },
                    },
                  ]),
                ),
              )
            : Effect.succeed(output(mergeRequestJson({ head_pipeline: pipeline }))),
      );
    }

    const read = (downstreamChecks: boolean) =>
      GitLabPullRequestCli.GitLabPullRequestCli.pipe(
        Effect.flatMap((cli) =>
          cli.getMergeRequestDetail({
            cwd: "/w",
            repository: "group/acme/web",
            number: 7,
            downstreamChecks,
          }),
        ),
      );

    it.effect("shows the stage jobs, and a stage GitLab listed no jobs for", () =>
      Effect.gen(function* () {
        answer(Effect.succeed(output(stages)));

        const detail = yield* read(true);

        const graphql = mockedExecute.mock.calls.find(([call]) => call.stdin?.includes("stages"));
        assert.isDefined(graphql);
        expect(JSON.parse(graphql[0].stdin ?? "").variables).toEqual({
          fullPath: "group/acme/web",
          iid: "7",
        });
        expect(detail.checks).toEqual([
          {
            name: "build",
            status: "success",
            description: "passed",
            url: "https://gitlab.com/acme/web/-/pipelines/9",
          },
          {
            name: "test / unit",
            status: "failure",
            description: null,
            url: "https://gitlab.com/acme/web/-/jobs/3",
          },
          {
            name: "deploy / child-pipeline",
            status: "failure",
            description: "Downstream pipeline",
            url: "https://gitlab.com/acme/child/-/pipelines/10",
          },
        ]);
      }),
    );

    it.effect("keeps the pipeline check where the stages cannot be read", () =>
      Effect.gen(function* () {
        answer(
          Effect.fail(
            new GitLabCli.GitLabCliCommandError({
              operation: "execute",
              command: "glab",
              cwd: "/w",
              cause: new Error("graphql unavailable"),
            }),
          ),
        );

        const detail = yield* read(true);

        expect(detail.checks).toEqual([
          {
            name: "Pipeline",
            status: "failure",
            description: "merge_request_event",
            url: "https://gitlab.com/acme/web/-/pipelines/9",
          },
          {
            name: "child-pipeline",
            status: "failure",
            description: "Downstream pipeline",
            url: "https://gitlab.com/acme/child/-/pipelines/10",
          },
        ]);
      }),
    );

    it.effect("asks for no stages when the caller only needs the merge request", () =>
      Effect.gen(function* () {
        answer(Effect.succeed(output(stages)));

        const detail = yield* read(false);

        expect(
          mockedExecute.mock.calls.filter(([call]) => call.stdin?.includes("stages")),
        ).toHaveLength(0);
        expect(detail.checks.map((check) => check.name)).toEqual(["Pipeline"]);
      }),
    );
  });
});
