import * as HostProcess from "@goat/shared/HostProcess";
import { isSameWorktreePath } from "./worktreePath.ts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";
import type { GitCommandError } from "@goat/contracts";
import { splitNullSeparatedGitStdoutPaths } from "./gitStdoutPaths.ts";

export const captureEmptySubmodules = Effect.fn("GitVcsDriver.captureEmptySubmodules")(
  function* (input: {
    readonly cwd: string;
    readonly fs: FileSystem.FileSystem;
    readonly path: Path.Path;
    readonly git: (
      operation: string,
      cwd: string,
      args: readonly string[],
    ) => Effect.Effect<string, GitCommandError>;
  }) {
    const { cwd, fs, path, git } = input;
    const platform = yield* HostProcess.Platform;
    const root = yield* fs.realPath(cwd);
    const config = yield* git("GitVcsDriver.listSubmodulePaths", cwd, [
      "config",
      "-z",
      "--file",
      ".gitmodules",
      "--get-regexp",
      "^submodule\\..*\\.path$",
    ]);
    const paths = splitNullSeparatedGitStdoutPaths({
      stdout: config,
      stdoutTruncated: false,
    }).flatMap((record) => {
      const newline = record.indexOf("\n");
      return newline < 0 ? [] : [record.slice(newline + 1)];
    });
    const eligible = yield* Effect.filter(paths, (relative) =>
      Effect.gen(function* () {
        const fullPath = path.resolve(root, relative);
        const normalized = path.relative(root, fullPath);
        if (
          !normalized ||
          normalized === ".." ||
          normalized.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        )
          return false;
        const realPath = yield* fs.realPath(fullPath);
        return (
          isSameWorktreePath(realPath, fullPath, platform) &&
          (yield* fs.readDirectory(fullPath)).length === 0
        );
      }).pipe(Effect.orElseSucceed(() => false)),
    );

    // An interrupted clone's checkout has only the Git link and has never written an index.
    return Effect.filter(eligible, (relative) =>
      Effect.gen(function* () {
        const fullPath = path.resolve(root, relative);
        if (!isSameWorktreePath(yield* fs.realPath(fullPath), fullPath, platform)) return false;
        const entries = yield* fs.readDirectory(fullPath);
        if (entries.length !== 1 || entries[0] !== ".git") return false;
        if ((yield* fs.stat(path.join(fullPath, ".git"))).type !== "File") return false;
        const topLevel = yield* git("GitVcsDriver.submoduleRoot", fullPath, [
          "rev-parse",
          "--show-toplevel",
        ]);
        if (!isSameWorktreePath(topLevel.trimEnd(), fullPath, platform)) return false;
        const index = yield* git("GitVcsDriver.submoduleIndex", fullPath, [
          "rev-parse",
          "--git-path",
          "index",
        ]);
        return !(yield* fs.exists(path.resolve(fullPath, index.trimEnd())));
      }).pipe(Effect.orElseSucceed(() => false)),
    );
  },
);
