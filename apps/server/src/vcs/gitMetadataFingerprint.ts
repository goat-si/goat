import * as Cache from "effect/Cache";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { detachStackFrame } from "../git/detachStackFrame.ts";

// Gitfiles and commondir make linked worktrees share config while keeping their own HEAD.
// Unknown layouts or inaccessible metadata disable reuse; git remains authoritative.
export const makeGitMetadataFingerprint = Effect.fn("GitMetadataFingerprint.make")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  // The outer read span owns validation; tracing every stat would multiply hot-path spans.
  const stamp = Effect.fnUntraced(function* (file: string) {
    return yield* fs.stat(file).pipe(
      Effect.map(
        (info) =>
          `${Option.getOrNull(info.ino)}:${info.size}:${Option.getOrNull(info.mtime)?.getTime()}`,
      ),
      Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed("missing")),
    );
  });
  const directories = yield* Cache.makeWith(
    (cwd: string) =>
      Effect.gen(function* () {
        let root = yield* fs.realPath(path.resolve(cwd));
        while (true) {
          const candidate = path.join(root, ".git");
          const info = yield* fs.stat(candidate).pipe(
            Effect.map(Option.some),
            Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(Option.none())),
          );
          if (Option.isSome(info)) {
            const gitDir =
              info.value.type === "Directory"
                ? candidate
                : path.resolve(
                    root,
                    (yield* fs.readFileString(candidate)).replace(/^gitdir: /, "").trim(),
                  );
            const common = yield* fs
              .readFileString(path.join(gitDir, "commondir"))
              .pipe(Effect.catchReason("PlatformError", "NotFound", () => Effect.succeed(".")));
            return { root, gitDir, commonDir: path.resolve(gitDir, common.trim()) };
          }
          const parent = path.dirname(root);
          if (parent === root) return null;
          root = parent;
        }
      }).pipe(Effect.orElseSucceed(() => null)),
    {
      capacity: 2048,
      timeToLive: (exit) =>
        exit._tag === "Success" && exit.value !== null ? "1 second" : "0 seconds",
    },
  );
  return Effect.fn("GitMetadataFingerprint.read")(
    function* (cwd: string, branch?: string) {
      const dirs = yield* detachStackFrame(Cache.get(directories, path.resolve(cwd)));
      if (dirs === null) return null;
      const repositoryFiles = [
        path.join(dirs.gitDir, "HEAD"),
        path.join(dirs.gitDir, "config.worktree"),
        path.join(dirs.commonDir, "config"),
      ];
      const refFiles =
        branch === undefined
          ? []
          : [
              path.join(dirs.commonDir, "packed-refs"),
              path.join(dirs.commonDir, "reftable", "tables.list"),
              path.join(dirs.commonDir, "refs", "heads", branch),
            ];
      const stamps = yield* Effect.forEach([...repositoryFiles, ...refFiles], stamp, {
        concurrency: "unbounded",
      });
      return {
        root: dirs.root,
        repository: `${dirs.gitDir}\u0000${stamps.slice(0, repositoryFiles.length).join("\u0000")}`,
        refs: stamps.slice(repositoryFiles.length).join("\u0000"),
      };
    },
    Effect.orElseSucceed(() => null),
  );
});
