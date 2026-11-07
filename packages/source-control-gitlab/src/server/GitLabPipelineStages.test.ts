import * as Result from "effect/Result";
import { describe, expect, it } from "vite-plus/test";
import { decodePipelineStageChecksJson } from "./gitLabPipelineStages.ts";
function expectSuccess<A>(result: Result.Result<A, unknown>): A {
  expect(Result.isSuccess(result)).toBe(true);
  if (!Result.isSuccess(result)) throw new Error("expected a successful decode");
  return result.success;
}

describe("decodePipelineStageChecksJson", () => {
  function stagesJson(
    stages: ReadonlyArray<Record<string, unknown> | null> | null,
    hasNextPage = false,
  ): string {
    return JSON.stringify({
      data: {
        project: {
          mergeRequest: {
            headPipeline:
              stages === null
                ? null
                : {
                    path: "/fork/web/-/pipelines/9",
                    stages: { nodes: stages, pageInfo: { hasNextPage } },
                  },
          },
        },
      },
    });
  }

  it("shows every job under its stage", () => {
    const checks = expectSuccess(
      decodePipelineStageChecksJson(
        stagesJson([
          {
            name: "build",
            status: "success",
            jobs: {
              nodes: [
                { name: "compile", status: "FAILED", retried: true, webPath: "/acme/web/-/jobs/1" },
                {
                  name: "compile",
                  status: "SUCCESS",
                  detailedStatus: { label: "passed" },
                  webPath: "/acme/web/-/jobs/2",
                },
              ],
            },
          },
          {
            name: "test",
            status: "failed",
            jobs: {
              nodes: [
                {
                  name: "unit",
                  status: "FAILED",
                  allowFailure: false,
                  webPath: "/acme/web/-/jobs/3",
                },
                {
                  name: "lint",
                  status: "FAILED",
                  allowFailure: true,
                  webPath: "/acme/web/-/jobs/4",
                },
                { name: "slow", status: "CANCELED", webPath: "/acme/web/-/jobs/5" },
                { name: "e2e", status: "RUNNING", webPath: "/acme/web/-/jobs/6" },
              ],
            },
          },
          {
            name: "deploy",
            status: "manual",
            jobs: { nodes: [{ name: "release", status: "MANUAL", webPath: "/acme/web/-/jobs/7" }] },
          },
        ]),
        "https://gitlab.example.com",
      ),
    );

    expect(checks?.map((check) => [check.name, check.status, check.url])).toEqual([
      ["build / compile", "success", "https://gitlab.example.com/acme/web/-/jobs/2"],
      ["test / unit", "failure", "https://gitlab.example.com/acme/web/-/jobs/3"],
      ["test / lint", "neutral", "https://gitlab.example.com/acme/web/-/jobs/4"],
      ["test / slow", "cancelled", "https://gitlab.example.com/acme/web/-/jobs/5"],
      ["test / e2e", "pending", "https://gitlab.example.com/acme/web/-/jobs/6"],
      ["deploy / release", "neutral", "https://gitlab.example.com/acme/web/-/jobs/7"],
    ]);
    expect(checks?.[0]?.description).toBe("passed");
  });

  it.each([
    ["no jobs", undefined],
    ["an empty job list", { nodes: [] }],
    [
      "more jobs than one page",
      { nodes: [{ name: "unit", status: "FAILED" }], pageInfo: { hasNextPage: true } },
    ],
    ["a job GitLab could not resolve", { nodes: [{ name: "unit", status: "FAILED" }, null] }],
    [
      "a job without a name",
      {
        nodes: [
          { name: "unit", status: "FAILED" },
          { name: null, status: "FAILED" },
        ],
      },
    ],
  ])("keeps a stage whole where its jobs come back with %s", (_, jobs) => {
    expect(
      expectSuccess(
        decodePipelineStageChecksJson(
          stagesJson([
            {
              name: "test",
              status: "failed",
              detailedStatus: { label: "failed", detailsPath: "/fork/web/-/pipelines/9#test" },
              ...(jobs === undefined ? {} : { jobs }),
            },
          ]),
          "https://gitlab.com",
        ),
      ),
    ).toEqual([
      {
        name: "test",
        status: "failure",
        description: "failed",
        url: "https://gitlab.com/fork/web/-/pipelines/9#test",
      },
    ]);
  });

  it("answers nothing where there are no stages to show", () => {
    expect(
      expectSuccess(decodePipelineStageChecksJson(stagesJson(null), "https://gitlab.com")),
    ).toBe(null);
    expect(expectSuccess(decodePipelineStageChecksJson(stagesJson([]), "https://gitlab.com"))).toBe(
      null,
    );
    // A stage past the first page could be the failed one.
    expect(
      expectSuccess(
        decodePipelineStageChecksJson(
          stagesJson([{ name: "build", status: "success" }], true),
          "https://gitlab.com",
        ),
      ),
    ).toBe(null);
    // A stage GitLab failed to resolve comes back null beside an error, and could be the failed one.
    expect(
      expectSuccess(
        decodePipelineStageChecksJson(
          stagesJson([{ name: "build", status: "success" }, null]),
          "https://gitlab.com",
        ),
      ),
    ).toBe(null);
    expect(
      expectSuccess(
        decodePipelineStageChecksJson(
          stagesJson([
            { name: "build", status: "success" },
            { name: null, status: "failed" },
          ]),
          "https://gitlab.com",
        ),
      ),
    ).toBe(null);
    expect(
      expectSuccess(
        decodePipelineStageChecksJson(
          JSON.stringify({
            ...JSON.parse(stagesJson([{ name: "build", status: "success" }])),
            errors: [{ message: "boom" }],
          }),
          "https://gitlab.com",
        ),
      ),
    ).toBe(null);
    // GitLab answers an error it hit with no data at all.
    expect(
      expectSuccess(
        decodePipelineStageChecksJson(
          JSON.stringify({ errors: [{ message: "boom" }] }),
          "https://gitlab.com",
        ),
      ),
    ).toBe(null);
  });
});
