// @effect-diagnostics nodeBuiltinImport:off - lstat must not follow untracked symlinks.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

export const untrackedExceedsLimit = (cwd: string, paths: ReadonlyArray<string>, limit: number) =>
  Effect.forEach(
    paths,
    (path) =>
      Effect.tryPromise({
        try: () => NodeFSP.lstat(NodePath.resolve(cwd, path)),
        catch: () => undefined,
      }).pipe(
        Effect.map((info) => (info.isFile() ? info.size : 0)),
        Effect.orElseSucceed(() => Infinity),
      ),
    { concurrency: 16 },
  ).pipe(Effect.map((sizes) => sizes.reduce((total, size) => total + size, 0) > limit));
