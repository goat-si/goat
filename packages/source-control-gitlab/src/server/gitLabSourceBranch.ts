import * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@goat/shared/schemaJson";
type DecodeFailure = Cause.Cause<Schema.SchemaError>;
function trimmed(value: string | null | undefined): string | null {
  const text = value?.trim() ?? "";
  return text.length > 0 ? text : null;
}

export const SOURCE_BRANCH_GRAPHQL_QUERY = `query($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) {
    mergeRequest(iid: $iid) {
      state sourceBranch diffHeadSha
      sourceProject { fullPath }
      userPermissions { removeSourceBranch }
    }
  }
}`;

const RawSourceBranchSchema = Schema.Struct({
  data: Schema.Struct({
    project: Schema.NullOr(
      Schema.Struct({
        mergeRequest: Schema.NullOr(
          Schema.Struct({
            state: Schema.String,
            sourceBranch: Schema.String,
            diffHeadSha: Schema.optional(Schema.NullOr(Schema.String)),
            sourceProject: Schema.optional(
              Schema.NullOr(Schema.Struct({ fullPath: Schema.String })),
            ),
            userPermissions: Schema.optional(
              Schema.NullOr(
                Schema.Struct({
                  removeSourceBranch: Schema.optional(Schema.NullOr(Schema.Boolean)),
                }),
              ),
            ),
          }),
        ),
      }),
    ),
  }),
});

const decodeSourceBranch = decodeJsonResult(RawSourceBranchSchema);

export interface GitLabSourceBranch {
  readonly open: boolean;
  readonly branch: string;
  readonly headSha: string | null;
  /** Null when the source project is gone or hidden from the viewer, as a deleted fork is. */
  readonly sourceProject: string | null;
  /** GitLab's own answer: false once the branch is gone, protected, or out of the viewer's reach. */
  readonly canDelete: boolean;
}

export function decodeSourceBranchJson(
  raw: string,
): Result.Result<GitLabSourceBranch | null, DecodeFailure> {
  return Result.map(decodeSourceBranch(raw), (decoded) => {
    const mergeRequest = decoded.data.project?.mergeRequest;
    if (mergeRequest == null) return null;
    return {
      // `locked` is GitLab's transient state while a merge runs, so only these two are settled.
      open: mergeRequest.state !== "merged" && mergeRequest.state !== "closed",
      branch: mergeRequest.sourceBranch,
      headSha: trimmed(mergeRequest.diffHeadSha),
      sourceProject: mergeRequest.sourceProject?.fullPath ?? null,
      canDelete: mergeRequest.userPermissions?.removeSourceBranch === true,
    };
  });
}

const decodeBranch = decodeJsonResult(
  Schema.Struct({
    default: Schema.optional(Schema.NullOr(Schema.Boolean)),
    commit: Schema.optional(
      Schema.NullOr(
        Schema.Struct({
          id: Schema.String,
          authored_date: Schema.optional(Schema.NullOr(Schema.String)),
        }),
      ),
    ),
  }),
);

export function decodeBranchJson(raw: string): Result.Result<
  {
    readonly isDefault: boolean;
    readonly headSha: string | null;
    readonly headAuthoredDate: string | null;
  },
  DecodeFailure
> {
  return Result.map(decodeBranch(raw), (branch) => ({
    isDefault: branch.default === true,
    headSha: trimmed(branch.commit?.id),
    headAuthoredDate: trimmed(branch.commit?.authored_date),
  }));
}
