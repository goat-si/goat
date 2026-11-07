import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as GitLabCli from "./GitLabCli.ts";
import type { GitLabPullRequestCliError } from "./GitLabPullRequestCli.ts";
import { GitLabMergeRequestReadError } from "./gitLabPullRequestErrors.ts";
import { projectPath } from "./gitLabInput.ts";
import { query, searchParams } from "./gitLabQuery.ts";
import {
  decodeProjectUsersJson,
  type GitLabProjectUsers,
  type GitLabMergeRequestDetail,
} from "./gitLabMergeRequestJson.ts";

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

export function makeReviewerCandidates(
  mergeRequestDetail: (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
  }) => Effect.Effect<GitLabMergeRequestDetail, GitLabPullRequestCliError>,
  projectUsers: ReturnType<typeof makeGitLabProjectUsers>,
) {
  return Effect.fn("GitLabPullRequestCli.listReviewerCandidates")(function (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
    readonly query?: string | undefined;
  }) {
    return Effect.all(
      [mergeRequestDetail(input), projectUsers({ ...input, search: input.query })],
      {
        concurrency: 2,
      },
    ).pipe(
      Effect.map(([mergeRequest, users]) => {
        const author = mergeRequest.author?.login;
        const requested = (input.query?.trim() ? [] : mergeRequest.reviewerUsers).map(
          ({ id, ...actor }) => ({
            ...actor,
            id: String(id),
            kind: "user" as const,
            isRequested: true,
          }),
        );
        const listed = new Set(requested.map((reviewer) => reviewer.id));
        // Every reviewer id, not just the ones shown above: a reviewer GitLab sent without a
        // username can still turn up on the users page, and must read as requested there or
        // choosing them would ask again instead of taking the request back.
        const requestedIds = new Set(mergeRequest.reviewerIds.map(String));
        return {
          // The reviewers lead, and come from the merge request rather than the users page:
          // that page stops at a hundred, and somebody missing from it could not be taken off.
          // The author is dropped rather than shown unusable: GitLab refuses to make the person
          // who opened a merge request its reviewer.
          candidates: [
            ...requested,
            ...users.candidates
              .filter((candidate) => candidate.login !== author && !listed.has(candidate.id))
              .map((candidate) =>
                requestedIds.has(candidate.id) ? { ...candidate, isRequested: true } : candidate,
              ),
          ],
          truncated: users.rawCount >= MAX_PAGE_SIZE,
        };
      }),
    );
  });
}
