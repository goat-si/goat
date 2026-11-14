import type { GitCommandError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

export const mergeHeadExists = Effect.fn("GitVcsDriver.mergeHeadExists")(function* (
  cwd: string,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  runGitStdout: (
    operation: string,
    cwd: string,
    args: readonly string[],
  ) => Effect.Effect<string, GitCommandError>,
) {
  const physicalCwd = yield* fileSystem.realPath(cwd);
  const mergeHead = yield* runGitStdout("GitVcsDriver.prepareCommitContext.mergeHead", cwd, [
    "rev-parse",
    "--git-path",
    "MERGE_HEAD",
  ]);
  return yield* fileSystem.exists(path.resolve(physicalCwd, mergeHead.trim()));
});

export const commitContextObjects = Effect.fn("GitVcsDriver.commitContextObjects")(function* (
  cwd: string,
  directory: string,
  platform: string,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  runGitStdout: (
    operation: string,
    cwd: string,
    args: readonly string[],
  ) => Effect.Effect<string, GitCommandError>,
) {
  const physicalCwd = yield* fileSystem.realPath(cwd);
  const indexValue = yield* runGitStdout("GitVcsDriver.prepareCommitContext.indexPath", cwd, [
    "rev-parse",
    "--git-path",
    "index",
  ]);
  const objects = yield* runGitStdout("GitVcsDriver.prepareCommitContext.objects", cwd, [
    "rev-parse",
    "--git-path",
    "objects",
  ]);
  const output = yield* runGitStdout("GitVcsDriver.prepareCommitContext.alternates", cwd, [
    "count-objects",
    "-v",
  ]);
  const alternates = [
    path.resolve(physicalCwd, objects.replace(/\r?\n$/u, "")),
    ...output
      .split("\n")
      .flatMap((line) =>
        line.startsWith("alternate: ") ? [line.slice("alternate: ".length)] : [],
      ),
  ];
  const quote = (entry: string) =>
    entry.startsWith('"') ? entry : `"${entry.replace(/[\\"]/g, "\\$&")}"`;
  const objectsPath = path.join(directory, "objects");
  yield* fileSystem.makeDirectory(objectsPath);
  return {
    indexPath: path.resolve(physicalCwd, indexValue.trim()),
    env: {
      GIT_INDEX_FILE: path.join(directory, "index"),
      GIT_OBJECT_DIRECTORY: objectsPath,
      GIT_ALTERNATE_OBJECT_DIRECTORIES: alternates
        .map(quote)
        .join(platform === "win32" ? ";" : ":"),
    } satisfies NodeJS.ProcessEnv,
  };
});
