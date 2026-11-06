import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import type * as GitLabCli from "./GitLabCli.ts";
import { GitLabBranchDeletionRefusedError } from "./gitLabBranchDeletionError.ts";
import { GitLabMergeRequestReadError } from "./gitLabPullRequestErrors.ts";
import {
  decodeBranchJson,
  decodeSourceBranchJson,
  SOURCE_BRANCH_GRAPHQL_QUERY,
} from "./gitLabSourceBranch.ts";

export function makeGitLabBranchDeletion(options: {
  readonly api: (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly path: string;
    readonly method?: string;
    readonly headers?: ReadonlyArray<string>;
  }) => ReturnType<GitLabCli.GitLabCli["Service"]["execute"]>;
  readonly graphqlRead: <A>(input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly operation: string;
    readonly query: string;
    readonly variables: Record<string, unknown>;
    readonly decode: (raw: string) => Result.Result<A, unknown>;
  }) => Effect.Effect<A, GitLabCli.GitLabCliError | GitLabMergeRequestReadError>;
}) {
  const { api, graphqlRead } = options;
  const projectPath = (repository: string) => encodeURIComponent(repository.trim());
  const sourceBranch = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
  }) =>
    graphqlRead({
      cwd: input.cwd,
      host: input.host,
      operation: "getSourceBranch",
      query: SOURCE_BRANCH_GRAPHQL_QUERY,
      variables: { fullPath: input.repository, iid: String(input.number) },
      decode: decodeSourceBranchJson,
    });

  const deleteSourceBranch = Effect.fn("GitLabPullRequestCli.deleteSourceBranch")(
    function* (input: {
      readonly cwd: string;
      readonly host?: string | undefined;
      readonly repository: string;
      readonly number: number;
    }) {
      const refuse = (reason: GitLabBranchDeletionRefusedError["reason"]) =>
        new GitLabBranchDeletionRefusedError({
          command: "glab",
          cwd: input.cwd,
          number: input.number,
          reason,
        });
      const source = yield* sourceBranch(input);
      if (source === null) {
        return yield* new GitLabMergeRequestReadError({
          command: "glab",
          cwd: input.cwd,
          operation: "getSourceBranch",
          cause: new Error("GitLab reported no merge request."),
        });
      }
      if (source.open) return yield* refuse("open");
      if (!source.canDelete) return yield* refuse("not-allowed");
      if (source.sourceProject === null || source.headSha === null) {
        return yield* refuse("source-unavailable");
      }
      const path = `projects/${projectPath(source.sourceProject)}/repository/branches/${encodeURIComponent(source.branch)}`;
      const branch = yield* api({ cwd: input.cwd, host: input.host, path }).pipe(
        Effect.flatMap((result) => {
          const decoded = decodeBranchJson(result.stdout.trim());
          return Result.isSuccess(decoded)
            ? Effect.succeed(decoded.success)
            : Effect.fail(
                new GitLabMergeRequestReadError({
                  command: "glab",
                  cwd: input.cwd,
                  operation: "getSourceBranch",
                  cause: decoded.failure,
                }),
              );
        }),
      );
      if (branch.isDefault) return yield* refuse("default-branch");
      if (branch.headSha !== source.headSha) return yield* refuse("head-changed");
      // GitLab's branch delete takes no expected SHA. It answers 412 when the head's authored
      // date is newer than If-Unmodified-Since, which catches a commit pushed after this read but
      // not a force-push of an older-dated commit (a rebase keeps author dates).
      const authoredAt =
        branch.headAuthoredDate === null ? Option.none() : DateTime.make(branch.headAuthoredDate);
      yield* api({
        cwd: input.cwd,
        host: input.host,
        path,
        method: "DELETE",
        ...(Option.isNone(authoredAt)
          ? {}
          : {
              headers: [
                `If-Unmodified-Since: ${DateTime.toDateUtc(authoredAt.value).toUTCString()}`,
              ],
            }),
      });
    },
  );

  return { sourceBranch, deleteSourceBranch };
}
