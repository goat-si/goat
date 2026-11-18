import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

export const makeCanonicalWorktreePaths = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  pathKey: (target: string) => string,
  inside: (root: string, target: string) => boolean,
) => {
  const cache = new Map<string, string>();
  // Per-path lookup runs throughout cleanup; a span for each one would overwhelm tracing.
  const canonical = Effect.fnUntraced(function* (target: string) {
    const resolved = path.resolve(target);
    const cached = cache.get(resolved);
    if (cached !== undefined) return cached;
    const actual = yield* fs.realPath(resolved).pipe(Effect.orElseSucceed(() => resolved));
    const key = pathKey(actual);
    if (cache.size >= 4096) cache.clear();
    cache.set(resolved, key);
    return key;
  });
  // Each live session can have several aliases, so avoid a span for each path comparison.
  const occupies = Effect.fnUntraced(function* (worktrees: ReadonlyArray<string>, target: string) {
    const targets = [path.resolve(target), yield* canonical(target)];
    return worktrees.some((root) =>
      targets.some((cwd) => pathKey(root) === pathKey(cwd) || inside(root, cwd)),
    );
  });
  const containsProjectRoot = Effect.fn("StorageCleanup.containsProjectRoot")(function* (
    worktrees: ReadonlyArray<string>,
    projects: ReadonlyArray<{ readonly workspaceRoot: string }>,
  ) {
    for (const project of projects)
      if (yield* occupies(worktrees, project.workspaceRoot)) return true;
    return false;
  });
  return { canonical, occupies, containsProjectRoot, invalidate: () => cache.clear() };
};

export const worktreePathOf = (thread: { readonly worktreePath: string | null }) => {
  if (thread.worktreePath === null) throw new Error("Missing worktree path");
  return thread.worktreePath;
};
export const keyAt = (keys: ReadonlyArray<string>, index: number) => {
  const key = keys[index];
  if (key === undefined) throw new Error("Missing canonical worktree key");
  return key;
};
