import * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { decodeJsonResult } from "@goat/shared/schemaJson";

type DecodeFailure = Cause.Cause<Schema.SchemaError>;

export const MERGE_MESSAGES_GRAPHQL_QUERY = `query($fullPath: ID!, $iid: String!) {
  project(fullPath: $fullPath) {
    mergeRequest(iid: $iid) { title squashOnMerge defaultMergeCommitMessage defaultSquashCommitMessage }
  }
}`;

const RawMergeMessagesSchema = Schema.Struct({
  // A field that errored reads as null, which must not pass for an absent template.
  errors: Schema.optionalKey(Schema.Never),
  data: Schema.Struct({
    project: Schema.NullOr(
      Schema.Struct({
        mergeRequest: Schema.NullOr(
          Schema.Struct({
            title: Schema.optional(Schema.NullOr(Schema.String)),
            squashOnMerge: Schema.optional(Schema.NullOr(Schema.Boolean)),
            defaultMergeCommitMessage: Schema.optional(Schema.NullOr(Schema.String)),
            defaultSquashCommitMessage: Schema.optional(Schema.NullOr(Schema.String)),
          }),
        ),
      }),
    ),
  }),
});

const decodeMergeMessages = decodeJsonResult(RawMergeMessagesSchema);

export interface GitLabMergeMessages {
  readonly title: string | null;
  readonly merge: string | null;
  readonly squash: string | null;
  /** GitLab squashes when the project always does or the merge request asks to. */
  readonly squashOnMerge: boolean;
}

/** The messages GitLab would write from the project's merge and squash templates. */
export function decodeMergeMessagesJson(
  raw: string,
): Result.Result<GitLabMergeMessages, DecodeFailure> {
  return Result.map(decodeMergeMessages(raw), (decoded) => {
    const mergeRequest = decoded.data.project?.mergeRequest;
    return {
      title: mergeRequest?.title ?? null,
      merge: mergeRequest?.defaultMergeCommitMessage ?? null,
      squash: mergeRequest?.defaultSquashCommitMessage ?? null,
      squashOnMerge: mergeRequest?.squashOnMerge === true,
    };
  });
}
