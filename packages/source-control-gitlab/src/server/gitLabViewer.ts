import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import type * as GitLabCli from "./GitLabCli.ts";
import type { GitLabPullRequestCliError } from "./GitLabPullRequestCli.ts";
import { decodeViewerJson } from "./gitLabMergeRequestJson.ts";
import {
  GitLabMergeRequestReadError,
  GitLabViewerUnavailableError,
} from "./gitLabPullRequestErrors.ts";
export function makeGitLabViewer(
  api: (input: {
    readonly cwd: string;
    readonly host?: string | undefined;
    readonly path: string;
  }) => ReturnType<GitLabCli.GitLabCli["Service"]["execute"]>,
) {
  const viewerUsername = (input: { readonly cwd: string; readonly host?: string | undefined }) =>
    api({ cwd: input.cwd, host: input.host, path: "user" }).pipe(
      Effect.flatMap((result): Effect.Effect<string, GitLabPullRequestCliError> => {
        const decoded = decodeViewerJson(result.stdout.trim());
        if (!Result.isSuccess(decoded)) {
          return Effect.fail(
            new GitLabMergeRequestReadError({
              command: "glab",
              cwd: input.cwd,
              operation: "getViewerUsername",
              cause: decoded.failure,
            }),
          );
        }
        return decoded.success === null
          ? Effect.fail(new GitLabViewerUnavailableError({ command: "glab", cwd: input.cwd }))
          : Effect.succeed(decoded.success);
      }),
    );

  return viewerUsername;
}
