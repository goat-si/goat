import { GitCommandError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { ExecuteGitResult } from "./GitVcsDriver.ts";
import { isMissingGitCwdError, isNonRepositoryGitStderr } from "./gitNonRepository.ts";

export const readStatusPaths = Effect.fn("GitVcsDriver.readStatusPaths")(function* (
  cwd: string,
  path: Path.Path,
  fileSystem: FileSystem.FileSystem,
  executeGitWithStableDiagnostics: (
    operation: string,
    cwd: string,
    args: readonly string[],
    options: { allowNonZeroExit: boolean },
  ) => Effect.Effect<ExecuteGitResult, GitCommandError>,
) {
  const readPaths = (...args: string[]) =>
    executeGitWithStableDiagnostics(
      "GitVcsDriver.statusDetails.indexPath",
      cwd,
      ["rev-parse", ...args],
      { allowNonZeroExit: true },
    ).pipe(
      Effect.catchTags({
        GitCommandError: (error) =>
          isMissingGitCwdError(error) ? Effect.succeed(null) : Effect.fail(error),
      }),
    );
  const paths = yield* readPaths(
    "--path-format=absolute",
    "--git-path",
    "index",
    "--git-common-dir",
    "--show-toplevel",
  );
  if (paths === null || (paths.exitCode !== 0 && isNonRepositoryGitStderr(paths.stderr))) {
    return undefined;
  }
  // Older Git may echo the flag. Newlines in paths also require the separate lookups.
  const fields = paths.stdout.replace(/\n$/, "").split("\n");
  const [index, commonDir, root] =
    paths.exitCode === 0 && fields.length === 3 && fields.every(path.isAbsolute) ? fields : [];
  const indexResult = index === undefined ? yield* readPaths("--git-path", "index") : undefined;
  if (indexResult === null) return undefined;
  const indexPath =
    index ?? (indexResult?.exitCode === 0 ? indexResult.stdout.replace(/\n$/, "") : undefined);
  if (indexPath) {
    const lockPath = `${path.resolve(cwd, indexPath)}.lock`;
    const lockError = new GitCommandError({
      operation: "GitVcsDriver.statusDetails.indexPath",
      command: "git",
      cwd,
      detail: "Git index is locked. Status will resume when the index lock is removed.",
    });
    // Status can succeed while locked, repeatedly running LFS clean filters without caching.
    if (
      yield* fileSystem.exists(lockPath).pipe(
        Effect.mapError(
          (cause) =>
            new GitCommandError({
              ...lockError,
              detail: "Failed to check the Git index lock.",
              cause,
            }),
        ),
      )
    ) {
      return yield* lockError;
    }
  }
  return { index, commonDir, root };
});
