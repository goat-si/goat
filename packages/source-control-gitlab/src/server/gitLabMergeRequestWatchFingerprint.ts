import * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@goat/shared/schemaJson";
import type { ProviderChangeRequestWatchFingerprint } from "@goat/source-control-core/server/PullRequestProvider";

type DecodeFailure = Cause.Cause<Schema.SchemaError>;
const trimmed = (value: string | null | undefined) => value?.trim() || null;
function textEditedAt(
  note: {
    readonly lastEditedAt?: string | null | undefined;
    readonly lastEditedBy?: { readonly username?: string | null | undefined } | null | undefined;
    readonly resolved?: boolean | null | undefined;
  } | null,
): string | null {
  const editedAt = trimmed(note?.lastEditedAt);
  return editedAt !== null &&
    trimmed(note?.lastEditedBy?.username) !== null &&
    note?.resolved !== true
    ? editedAt
    : null;
}

export const MERGE_REQUEST_WATCH_FINGERPRINT_GRAPHQL_QUERY = `query($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) {
    mergeRequest(iid: $iid) {
      state mergeStatusEnum detailedMergeStatus conflicts diffHeadSha
      userPermissions { updateMergeRequest }
      headPipeline {
        id status
        succeeded: jobs(retried: false, statuses: [SUCCESS]) { count }
        failed: jobs(retried: false, statuses: [FAILED]) { count }
        stopped: jobs(retried: false, statuses: [CANCELED, SKIPPED]) { count }
        jobs(jobKind: BRIDGE, retried: false, first: 100) {
          pageInfo { hasNextPage }
          nodes { name status downstreamPipeline { id status } }
        }
      }
      userNotesCount
      notes(filter: ONLY_COMMENTS, last: 100) {
        nodes { lastEditedAt lastEditedBy { username } resolved }
      }
    }
  }
}`;

const PipelineIdentitySchema = Schema.Struct({ id: Schema.String, status: Schema.String });
const JobCountSchema = Schema.NullOr(Schema.Struct({ count: Schema.Int }));
// GitLab's connection `count` stops at its default limit and answers `limit + 1` above it.
const JOB_COUNT_LIMIT = 1000;

const decodeMergeRequestWatchFingerprint = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      project: Schema.NullOr(
        Schema.Struct({
          mergeRequest: Schema.NullOr(
            Schema.Struct({
              state: Schema.String,
              mergeStatusEnum: Schema.NullOr(Schema.String),
              detailedMergeStatus: Schema.optional(Schema.NullOr(Schema.String)),
              conflicts: Schema.Boolean,
              diffHeadSha: Schema.NullOr(Schema.String),
              userPermissions: Schema.Struct({ updateMergeRequest: Schema.Boolean }),
              headPipeline: Schema.NullOr(
                Schema.Struct({
                  ...PipelineIdentitySchema.fields,
                  succeeded: JobCountSchema,
                  failed: JobCountSchema,
                  stopped: JobCountSchema,
                  jobs: Schema.NullOr(
                    Schema.Struct({
                      pageInfo: Schema.Struct({ hasNextPage: Schema.Boolean }),
                      nodes: Schema.Array(
                        Schema.NullOr(
                          Schema.Struct({
                            name: Schema.NullOr(Schema.String),
                            status: Schema.NullOr(Schema.String),
                            downstreamPipeline: Schema.NullOr(PipelineIdentitySchema),
                          }),
                        ),
                      ),
                    }),
                  ),
                }),
              ),
              userNotesCount: Schema.NullOr(Schema.Int),
              notes: Schema.Struct({
                nodes: Schema.Array(
                  Schema.NullOr(
                    Schema.Struct({
                      lastEditedAt: Schema.NullOr(Schema.String),
                      lastEditedBy: Schema.NullOr(
                        Schema.Struct({ username: Schema.NullOr(Schema.String) }),
                      ),
                      resolved: Schema.NullOr(Schema.Boolean),
                    }),
                  ),
                ),
              }),
            }),
          ),
        }),
      ),
    }),
  }),
);

/** Null when GitLab returned no merge request, so the watch falls back to full reads. */
export function decodeMergeRequestWatchFingerprintJson(
  raw: string,
): Result.Result<ProviderChangeRequestWatchFingerprint | null, DecodeFailure> {
  const decoded = decodeMergeRequestWatchFingerprint(raw);
  if (!Result.isSuccess(decoded)) {
    return Result.fail(decoded.failure);
  }
  const mr = decoded.success.data.project?.mergeRequest;
  if (mr == null) return Result.succeed(null);
  const newestEdit = mr.notes.nodes.reduce((newest, note) => {
    const editedAt = textEditedAt(note);
    return editedAt !== null && editedAt > newest ? editedAt : newest;
  }, "");
  const pipeline = mr.headPipeline;
  const jobCounts = [pipeline?.succeeded, pipeline?.failed, pipeline?.stopped].map(
    (jobs) => jobs?.count ?? null,
  );
  // Past a capped count or the first bridge page, a job can settle without moving the status.
  const seesEveryJob =
    pipeline?.jobs?.pageInfo.hasNextPage !== true &&
    jobCounts.every((count) => count === null || count <= JOB_COUNT_LIMIT);
  const bridges = (pipeline?.jobs?.nodes ?? [])
    .flatMap((job) =>
      job === null
        ? []
        : [
            [job.name, job.status, job.downstreamPipeline?.id, job.downstreamPipeline?.status]
              .map((part) => part ?? "")
              .join(":"),
          ],
    )
    .toSorted()
    .join(",");
  return Result.succeed({
    status: [
      mr.state,
      mr.mergeStatusEnum ?? "",
      mr.detailedMergeStatus ?? "",
      mr.conflicts,
      mr.diffHeadSha ?? "",
      pipeline?.id ?? "",
      pipeline?.status ?? "",
      jobCounts.map((count) => count ?? "").join("/"),
      bridges,
    ].join(" "),
    remarks: [mr.userNotesCount ?? "", newestEdit].join(" "),
    // GraphQL never asks GitLab to recheck mergeability. The REST detail read does, but only for
    // viewers who can update the merge request, so only they keep detail reads going until it settles.
    coversDetail:
      seesEveryJob &&
      (mr.conflicts ||
        !mr.userPermissions.updateMergeRequest ||
        mr.mergeStatusEnum === "CAN_BE_MERGED" ||
        mr.mergeStatusEnum === "CANNOT_BE_MERGED"),
  });
}
