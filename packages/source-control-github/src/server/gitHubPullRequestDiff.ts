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
const COMPARE_FILES_LIMIT = 300;
const isImmutableSha = (value: string) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i.test(value);

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

    const readRevision = () =>
      api.rest({ host: input.host, operation, path: requestPath }).pipe(
        Effect.map((response) => {
          if (response.truncated) return undefined;
          const refs = Option.getOrUndefined(decodeRevisionRefs(response.body));
          const baseSha = refs?.base?.sha;
          const headSha = refs?.head?.sha;
          return baseSha && headSha && isImmutableSha(baseSha) && isImmutableSha(headSha)
            ? { baseSha: baseSha.toLowerCase(), headSha: headSha.toLowerCase() }
            : undefined;
        }),
      );
    const comparePath = (revision: NonNullable<typeof input.revision>) =>
      `repos/${owner}/${name}/compare/${revision.baseSha}...${revision.headSha}`;
    const preferPinnedFiles = Effect.fn("GitHubPullRequestApi.pinDiffFiles")(function* (
      page: GitHubPullRequestDiffSlice,
    ) {
      if (!page.omittedFileStats?.length) return page;
      const revision = yield* readRevision();
      if (revision === undefined) return page;
      const response = yield* api.rest({
        host: input.host,
        operation,
        // GitHub includes up to 300 files on the first compare page only.
        path: comparePath(revision) + "?per_page=1",
        maxResponseBytes: DIFF_MAX_OUTPUT_BYTES,
        timeout: DIFF_TIMEOUT,
      });
      if (response.truncated) return page;
      const files = yield* decodeWith(input.cwd, operation, decodeCommitFilesJson, response.body);
      if (files.rawCount === 0 || files.rawCount >= COMPARE_FILES_LIMIT) return page;
      return {
        patch: files.patch,
        truncated: files.truncated,
        nextCursor: null,
        revision,
        ...(files.omittedFileStats.length > 0
          ? { withheldFilesReadable: true, omittedFileStats: files.omittedFileStats }
          : {}),
      } satisfies GitHubPullRequestDiffSlice;
    });

    if (input.path !== undefined) {
      let diffPath = requestPath;
      if (input.commit === undefined) {
        const expected = input.revision;
        if (!expected || !isImmutableSha(expected.baseSha) || !isImmutableSha(expected.headSha)) {
          return yield* readError(
            input.cwd,
            operation,
            new Error("An aggregate file read requires the page's base and head revisions."),
          );
        }
        const current = yield* readRevision();
        if (
          current === undefined ||
          current.baseSha !== expected.baseSha.toLowerCase() ||
          current.headSha !== expected.headSha.toLowerCase()
        ) {
          return yield* readError(
            input.cwd,
            operation,
            new Error("The pull request revision changed before the file could be loaded."),
          );
        }
        diffPath = comparePath(current);
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
    if (input.commit !== undefined) {
      return yield* filesPage(1).pipe(
        Effect.map((page) => ({ ...page, withheldFilesReadable: true })),
      );
    }
    return yield* fullDiff(requestPath, DIFF_MAX_OUTPUT_BYTES).pipe(
      Effect.flatMap((response) =>
        response.truncated
          ? filesPage(1).pipe(
              Effect.flatMap((page) =>
                preferPinnedFiles(page).pipe(Effect.orElseSucceed(() => page)),
              ),
            )
          : Effect.succeed({ patch: response.body, truncated: false, nextCursor: null }),
      ),
      // GitHub's refusal also applies to single-file reads from the full diff.
      Effect.catchTags({
        GitHubApiResponseError: (error) => filesPage(1).pipe(Effect.mapError(() => error)),
      }),
    );
  });
}
