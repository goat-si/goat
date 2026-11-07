import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as GitLabCli from "./GitLabCli.ts";
import type { GitLabPullRequestCliError } from "./GitLabPullRequestCli.ts";
import { GitLabMergeRequestReadError } from "./gitLabPullRequestErrors.ts";
import { projectPath } from "./gitLabInput.ts";
import { query, searchParams } from "./gitLabQuery.ts";
import { decodeProjectUsersJson, type GitLabProjectUsers } from "./gitLabMergeRequestJson.ts";

const MAX_PAGE_SIZE = 100;
export function makeGitLabProjectUsers(
  api: (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly path: string;
  }) => ReturnType<GitLabCli.GitLabCli["Service"]["execute"]>,
) {
  const projectUsers = (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly search?: string | undefined;
  }): Effect.Effect<GitLabProjectUsers, GitLabPullRequestCliError> =>
    api({
      cwd: input.cwd,
      host: input.host,
      path: `projects/${projectPath(input.repository)}/users?${query([
        ["per_page", String(MAX_PAGE_SIZE)],
        ...searchParams(input.search, 3),
      ])}`,
    }).pipe(
      Effect.flatMap((result) => {
        const decoded = decodeProjectUsersJson(result.stdout.trim());
        return Result.isSuccess(decoded)
          ? Effect.succeed(decoded.success)
          : Effect.fail(
              new GitLabMergeRequestReadError({
                command: "glab",
                cwd: input.cwd,
                operation: "listReviewerCandidates",
                cause: decoded.failure,
              }),
            );
      }),
    );

  return projectUsers;
}
