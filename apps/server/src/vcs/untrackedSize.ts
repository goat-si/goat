// @effect-diagnostics nodeBuiltinImport:off - lstat must not follow untracked symlinks.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";

export const selectUntrackedWithinLimit = (cwd: string, paths: ReadonlyArray<string>) =>
  Effect.forEach(
    paths,
    (relativePath) =>
      Effect.tryPromise({
        try: () => NodeFSP.lstat(NodePath.resolve(cwd, relativePath)),
        catch: () => undefined,
      }).pipe(
        Effect.map((info) => ({ relativePath, size: info.isFile() ? info.size : 0 })),
        Effect.orElseSucceed(() => ({ relativePath, size: Infinity })),
      ),
    { concurrency: 16 },
  ).pipe(
    Effect.map((items) => {
      const selected: string[] = [];
      let bytes = 0;
      for (const item of items.toSorted((a, b) => a.size - b.size)) {
        bytes += item.size;
        if (bytes > 256 * 1024 * 1024) break;
        selected.push(item.relativePath);
      }
      return { selected, omitted: selected.length < items.length };
    }),
  );
