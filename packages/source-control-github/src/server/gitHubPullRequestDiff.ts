import {
  diffFileSection,
  truncateLongDiffLines,
} from "@goat/source-control-core/server/diffFileRevisions";
import * as Option from "effect/Option";
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
import {
  decodeRevisionRefs,
  diffCursorPage,
  isCommitSha,
  parseRepositorySelector,
} from "./gitHubPullRequestInput.ts";
import { decodeCommitFilesJson, decodePullRequestFilesJson } from "./gitHubPullRequestJson.ts";

/** A large pull request can produce a multi-megabyte patch; past this it is truncated. */
const DIFF_MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
export const DIFF_TIMEOUT = Duration.seconds(60);
const DIFF_FILES_PAGE_SIZE = 100;
const WITHHELD_FILE_RESPONSE_LIMIT = 32 * 1024 * 1024;
const WITHHELD_FILE_LINE_LIMIT = 1_000;

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

  return Effect.fn("GitHubPullRequestApi.getPullRequestDiff")(function* (input) {
    const filesPage = (page: number) => diffFilesPage({ ...input, page });
    const { owner, name } = parseRepositorySelector(input.repository);
    if (input.commit !== undefined && !isCommitSha(input.commit)) {
      return yield* new GitHubDiffCommitError({ cwd: input.cwd });
    }
    const operation = "getPullRequestDiff";
    const requestPath =
      input.commit === undefined
        ? `repos/${owner}/${name}/pulls/${input.number}`
        : `repos/${owner}/${name}/commits/${input.commit}`;
    const fullDiff = (path: string, maxResponseBytes: number) =>
      api.rest({
        host: input.host,
        operation,
        path,
        accept: "application/vnd.github.diff",
        maxResponseBytes,
        timeout: DIFF_TIMEOUT,
      });

    if (input.path !== undefined) {
      let diffPath = requestPath;
      if (input.commit === undefined && input.expectedHeadSha !== undefined) {
        const current = yield* api.rest({ host: input.host, operation, path: requestPath });
        const refs = Option.getOrUndefined(decodeRevisionRefs(current.body));
        const base = refs?.base?.sha;
        const head = refs?.head?.sha;
        if (
          current.truncated ||
          base === undefined ||
          head === undefined ||
          !isCommitSha(base) ||
          !isCommitSha(head) ||
          head.toLowerCase() !== input.expectedHeadSha.toLowerCase()
        ) {
          return yield* readError(
            input.cwd,
            operation,
            new Error("The pull request revision changed before the file could be loaded."),
          );
        }
        diffPath = `repos/${owner}/${name}/compare/${base}...${head}`;
      }
      const response = yield* fullDiff(diffPath, WITHHELD_FILE_RESPONSE_LIMIT);
      const section =
        response.truncated || response.invalidUtf8
          ? null
          : diffFileSection(response.body, input.path);
      const patch =
        section === null ? null : truncateLongDiffLines(section, WITHHELD_FILE_LINE_LIMIT);
      if (patch === null) {
        return yield* readError(
          input.cwd,
          operation,
          new Error("The requested file is missing or its diff is too large to load."),
        );
      }
      return { patch, truncated: false, nextCursor: null };
    }

    if (input.cursor !== undefined) {
      const page = diffCursorPage(input.cursor);
      return yield* page === null
        ? Effect.fail(new GitHubDiffCursorError({ cwd: input.cwd }))
        : filesPage(page);
    }
    const readableFirstPage = () =>
      filesPage(1).pipe(
        Effect.map((page): GitHubPullRequestDiffSlice => ({
          ...page,
          withheldFilesReadable: true,
        })),
      );
    if (input.commit !== undefined) return yield* readableFirstPage();
    return yield* fullDiff(requestPath, DIFF_MAX_OUTPUT_BYTES).pipe(
      Effect.flatMap((response) =>
        response.truncated
          ? readableFirstPage()
          : Effect.succeed({ patch: response.body, truncated: false, nextCursor: null }),
      ),
      // GitHub's refusal also applies to single-file reads from the full diff.
      Effect.catchTags({
        GitHubApiResponseError: (error) => filesPage(1).pipe(Effect.mapError(() => error)),
      }),
    );
  });
}
