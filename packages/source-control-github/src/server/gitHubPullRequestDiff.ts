import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type {
  GitHubPullRequestApi,
  GitHubPullRequestApiError,
  GitHubPullRequestDiffSlice,
} from "./GitHubPullRequestApi.ts";
import {
  decodeWith,
  readError,
  GitHubDiffCommitError,
  GitHubDiffCursorError,
} from "./gitHubPullRequestReadErrors.ts";
import type { GitHubRest } from "./GitHubRest.ts";
import { diffCursorPage, isCommitSha, parseRepositorySelector } from "./gitHubPullRequestInput.ts";
import { decodeCommitFilesJson, decodePullRequestFilesJson } from "./gitHubPullRequestJson.ts";

/** A large pull request can produce a multi-megabyte patch; past this it is truncated. */
const DIFF_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const DIFF_TIMEOUT = Duration.seconds(60);
const DIFF_FILES_PAGE_SIZE = 100;

export function makeGitHubPullRequestDiff(
  api: GitHubRest["Service"],
): GitHubPullRequestApi["Service"]["getPullRequestDiff"] {
  const diffFilesPage = (input: {
    readonly cwd: string;
    readonly repository: string;
    readonly host: string;
    readonly number: number;
    readonly page: number;
    readonly commit?: string | undefined;
  }): Effect.Effect<GitHubPullRequestDiffSlice, GitHubPullRequestApiError> => {
    const { owner, name } = parseRepositorySelector(input.repository);
    const paging = `per_page=${DIFF_FILES_PAGE_SIZE}&page=${input.page}`;
    return api
      .rest({
        host: input.host,
        operation: "getPullRequestDiff",
        path:
          input.commit === undefined
            ? `repos/${owner}/${name}/pulls/${input.number}/files?${paging}`
            : `repos/${owner}/${name}/commits/${input.commit}?${paging}`,
        maxResponseBytes: DIFF_MAX_OUTPUT_BYTES,
        timeout: DIFF_TIMEOUT,
      })
      .pipe(
        Effect.flatMap((response) => {
          // Byte-truncated responses are unparseable JSON prefixes.
          if (response.truncated) {
            return Effect.fail(
              readError(
                input.cwd,
                "getPullRequestDiff",
                new Error(`Page ${input.page} of the changed files was too large to read.`),
              ),
            );
          }
          return decodeWith(
            input.cwd,
            "getPullRequestDiff",
            input.commit === undefined ? decodePullRequestFilesJson : decodeCommitFilesJson,
            response.body,
          );
        }),
        Effect.map((files) => {
          // Use raw row counts so malformed files cannot prematurely end pagination.
          const morePages = files.rawCount >= DIFF_FILES_PAGE_SIZE;
          return {
            patch: files.patch,
            truncated: files.truncated,
            nextCursor: morePages ? String(input.page + 1) : null,
            ...(files.omittedFileStats.length === 0
              ? {}
              : { omittedFileStats: files.omittedFileStats }),
          };
        }),
      );
  };

  return Effect.fn("GitHubPullRequestApi.getPullRequestDiff")(function (input) {
    const filesPage = (page: number) =>
      diffFilesPage({
        cwd: input.cwd,
        repository: input.repository,
        host: input.host,
        number: input.number,
        page,
        ...(input.commit === undefined ? {} : { commit: input.commit }),
      });
    if (input.commit !== undefined && !isCommitSha(input.commit)) {
      return Effect.fail(new GitHubDiffCommitError({ cwd: input.cwd }));
    }
    if (input.cursor !== undefined) {
      const page = diffCursorPage(input.cursor);
      return page === null
        ? Effect.fail(new GitHubDiffCursorError({ cwd: input.cwd }))
        : filesPage(page);
    }
    if (input.commit !== undefined) {
      return filesPage(1);
    }
    const { owner, name } = parseRepositorySelector(input.repository);
    return api
      .rest({
        host: input.host,
        operation: "getPullRequestDiff",
        path: `repos/${owner}/${name}/pulls/${input.number}`,
        accept: "application/vnd.github.diff",
        maxResponseBytes: DIFF_MAX_OUTPUT_BYTES,
        timeout: DIFF_TIMEOUT,
      })
      .pipe(
        Effect.flatMap((response) =>
          response.truncated
            ? filesPage(1)
            : Effect.succeed({ patch: response.body, truncated: false, nextCursor: null }),
        ),
        // Above 300 changed files, GitHub returns 406; use the paged files API.
        Effect.catchTags({
          GitHubApiResponseError: (error) => filesPage(1).pipe(Effect.mapError(() => error)),
        }),
      );
  });
}
