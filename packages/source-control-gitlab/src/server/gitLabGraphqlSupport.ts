import * as Effect from "effect/Effect";
import type * as Result from "effect/Result";
import type * as GitLabCli from "./GitLabCli.ts";
import type { GitLabMergeRequestReadError } from "./gitLabPullRequestErrors.ts";
import {
  decodeGraphqlListSupportJson,
  decodeLabelPermissionJson,
  LABEL_PERMISSION_GRAPHQL_QUERY,
  SERVER_VERSION_GRAPHQL_QUERY,
} from "./gitLabMergeRequestJson.ts";
export function makeGitLabGraphqlSupport(
  graphqlRead: <A>(input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly operation: string;
    readonly query: string;
    readonly variables: Record<string, unknown>;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }) => Effect.Effect<A, GitLabCli.GitLabCliError | GitLabMergeRequestReadError>,
) {
  const labelPermission = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
  }) =>
    graphqlRead({
      cwd: input.cwd,
      host: input.host,
      operation: "getLabelPermission",
      query: LABEL_PERMISSION_GRAPHQL_QUERY,
      variables: { fullPath: input.repository, iid: String(input.number) },
      decode: decodeLabelPermissionJson,
    }).pipe(
      // The answer gates one optional control; an unusable CLI or account still surfaces.
      Effect.catchIf(
        (cause) =>
          cause._tag !== "GitLabCliUnavailableError" &&
          cause._tag !== "GitLabCliAuthenticationError" &&
          cause._tag !== "GitLabCliRateLimitError",
        () => Effect.succeed(false),
      ),
    );

  const supportsGraphqlList = Effect.fn("GitLabPullRequestCli.supportsGraphqlList")(
    (input: { readonly cwd: string; readonly host?: string | undefined }) =>
      graphqlRead({
        cwd: input.cwd,
        host: input.host,
        operation: "supportsGraphqlList",
        query: SERVER_VERSION_GRAPHQL_QUERY,
        variables: {},
        decode: decodeGraphqlListSupportJson,
      }),
  );

  return { labelPermission, supportsGraphqlList };
}
