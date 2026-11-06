import * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@goat/shared/schemaJson";
import type { PullRequestCheck } from "@goat/contracts";
import { trimmed, toPipelineStatus } from "./gitLabMergeRequestJson.ts";
type DecodeFailure = Cause.Cause<Schema.SchemaError>;

export const PIPELINE_STAGES_GRAPHQL_QUERY = `query($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) {
    mergeRequest(iid: $iid) {
      headPipeline {
        path
        stages(first: 100) {
          nodes {
            name
            status
            detailedStatus { label detailsPath }
            jobs(first: 100) {
              nodes {
                name status allowFailure retried webPath detailedStatus { label }
                downstreamPipeline { status path }
              }
              pageInfo { hasNextPage }
            }
          }
          pageInfo { hasNextPage }
        }
      }
    }
  }
}`;

const OptionalString = Schema.optional(Schema.NullOr(Schema.String));

const RawStageJobSchema = Schema.Struct({
  name: OptionalString,
  status: OptionalString,
  allowFailure: Schema.optional(Schema.NullOr(Schema.Boolean)),
  retried: Schema.optional(Schema.NullOr(Schema.Boolean)),
  webPath: OptionalString,
  detailedStatus: Schema.optional(Schema.NullOr(Schema.Struct({ label: OptionalString }))),
  downstreamPipeline: Schema.optional(
    Schema.NullOr(Schema.Struct({ status: OptionalString, path: OptionalString })),
  ),
});

const RawStageSchema = Schema.Struct({
  name: OptionalString,
  status: OptionalString,
  detailedStatus: Schema.optional(
    Schema.NullOr(Schema.Struct({ label: OptionalString, detailsPath: OptionalString })),
  ),
  jobs: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        nodes: Schema.Array(Schema.NullOr(RawStageJobSchema)),
        pageInfo: Schema.optional(
          Schema.NullOr(
            Schema.Struct({ hasNextPage: Schema.optional(Schema.NullOr(Schema.Boolean)) }),
          ),
        ),
      }),
    ),
  ),
});

const RawPipelineStagesSchema = Schema.Struct({
  errors: Schema.optional(Schema.NullOr(Schema.Array(Schema.Unknown))),
  data: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        project: Schema.NullOr(
          Schema.Struct({
            mergeRequest: Schema.NullOr(
              Schema.Struct({
                headPipeline: Schema.NullOr(
                  Schema.Struct({
                    path: OptionalString,
                    stages: Schema.optional(
                      Schema.NullOr(
                        Schema.Struct({
                          nodes: Schema.Array(Schema.NullOr(RawStageSchema)),
                          pageInfo: Schema.optional(
                            Schema.NullOr(
                              Schema.Struct({
                                hasNextPage: Schema.optional(Schema.NullOr(Schema.Boolean)),
                              }),
                            ),
                          ),
                        }),
                      ),
                    ),
                  }),
                ),
              }),
            ),
          }),
        ),
      }),
    ),
  ),
});

const decodePipelineStages = decodeJsonResult(RawPipelineStagesSchema);

/**
 * The head pipeline as one check per job, named after its stage. A stage whose jobs GitLab did
 * not list whole stays one check with GitLab's stage status. Null where there are no stages to
 * show, or GitLab returned only some of them, so the caller keeps the single pipeline check.
 */
export function decodePipelineStageChecksJson(
  raw: string,
  origin: string,
): Result.Result<ReadonlyArray<PullRequestCheck> | null, DecodeFailure> {
  const decoded = decodePipelineStages(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const pipeline = decoded.success.data?.project?.mergeRequest?.headPipeline;
  // Any stage left out could be the failed one, so a partial list is no list.
  if (
    (decoded.success.errors?.length ?? 0) > 0 ||
    pipeline?.stages?.pageInfo?.hasNextPage === true ||
    pipeline?.stages?.nodes.some((stage) => stage === null || trimmed(stage.name) === null) === true
  ) {
    return Result.succeed(null);
  }
  const link = (path: string | null) => (path?.startsWith("/") ? `${origin}${path}` : null);
  const checks: Array<PullRequestCheck> = [];
  for (const stage of pipeline?.stages?.nodes ?? []) {
    const name = trimmed(stage?.name);
    if (stage === null || name === null) continue;
    const jobs = stage.jobs?.nodes ?? [];
    const listedWhole =
      jobs.length > 0 &&
      stage.jobs?.pageInfo?.hasNextPage !== true &&
      jobs.every((job) => job !== null && trimmed(job.name) !== null);
    if (!listedWhole) {
      checks.push({
        name,
        status: toPipelineStatus(stage.status),
        description: trimmed(stage.detailedStatus?.label),
        url: link(trimmed(stage.detailedStatus?.detailsPath) ?? trimmed(pipeline?.path)),
      });
      continue;
    }
    for (const job of jobs) {
      if (job === null || job.retried === true) continue;
      // A trigger job reads as its downstream pipeline, as `decodeTriggerJobChecksJson` explains.
      const downstream = job.downstreamPipeline;
      const status = toPipelineStatus(downstream ? downstream.status : job.status);
      checks.push({
        name: `${name} / ${trimmed(job.name)}`,
        // The same reading as `manual`: GitLab was told this failure does not fail the pipeline.
        status: status === "failure" && job.allowFailure === true ? "neutral" : status,
        description: downstream ? "Downstream pipeline" : trimmed(job.detailedStatus?.label),
        url: link(trimmed(downstream ? downstream.path : job.webPath)),
      });
    }
  }
  return Result.succeed(checks.length === 0 ? null : checks);
}
