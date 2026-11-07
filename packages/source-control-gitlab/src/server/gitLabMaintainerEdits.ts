import { decodeJsonResult } from "@goat/shared/schemaJson";
import * as Cause from "effect/Cause";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

type DecodeFailure = Cause.Cause<Schema.SchemaError>;
export const MAINTAINER_EDITS_PERMISSION_GRAPHQL_QUERY = `query($fullPath: ID!, $iid: String!) {
  currentUser { username }
  project(fullPath: $fullPath) {
    visibility
    mergeRequest(iid: $iid) {
      author { username }
      userPermissions { pushToSourceBranch }
      sourceBranchProtected
      sourceProject { visibility }
    }
  }
}`;

const decodeMaintainerEditsPermission = decodeJsonResult(
  Schema.Struct({
    data: Schema.Struct({
      currentUser: Schema.NullOr(Schema.Struct({ username: Schema.String })),
      project: Schema.NullOr(
        Schema.Struct({
          visibility: Schema.NullOr(Schema.String),
          mergeRequest: Schema.NullOr(
            Schema.Struct({
              author: Schema.NullOr(Schema.Struct({ username: Schema.String })),
              userPermissions: Schema.Struct({ pushToSourceBranch: Schema.Boolean }),
              sourceBranchProtected: Schema.Boolean,
              sourceProject: Schema.NullOr(
                Schema.Struct({ visibility: Schema.NullOr(Schema.String) }),
              ),
            }),
          ),
        }),
      ),
    }),
  }),
);

export function decodeMaintainerEditsPermissionJson(
  raw: string,
): Result.Result<boolean, DecodeFailure> {
  const decoded = decodeMaintainerEditsPermission(raw);
  if (Result.isFailure(decoded)) return Result.fail(decoded.failure);
  const { currentUser, project } = decoded.success.data;
  const mergeRequest = project?.mergeRequest;
  const isPublicOrInternal = (visibility: string | null | undefined) =>
    visibility === "public" || visibility === "internal";
  return Result.succeed(
    currentUser !== null &&
      mergeRequest?.author?.username === currentUser.username &&
      mergeRequest.userPermissions.pushToSourceBranch &&
      !mergeRequest.sourceBranchProtected &&
      isPublicOrInternal(project?.visibility) &&
      isPublicOrInternal(mergeRequest.sourceProject?.visibility),
  );
}
