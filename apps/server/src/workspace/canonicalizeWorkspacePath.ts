import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

// A worktree removed by storage cleanup is recreated inside the reserved section, so resolve its
// nearest existing ancestor: a symlink alias above it must still canonicalize the same on both
// sides. Walks at most the path depth.
export const canonicalizeWorkspacePath = (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  target: string,
): Effect.Effect<string> =>
  fileSystem.realPath(target).pipe(
    Effect.catchReason("PlatformError", "NotFound", () => {
      const parent = path.dirname(target);
      return parent === target
        ? Effect.succeed(target)
        : canonicalizeWorkspacePath(fileSystem, path, parent).pipe(
            Effect.map((resolved) => path.join(resolved, path.basename(target))),
          );
    }),
    Effect.orElseSucceed(() => target),
  );
