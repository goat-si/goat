import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import type * as Path from "effect/Path";

import type { GitVcsDriver } from "./vcs/GitVcsDriver.ts";

/** What the nested-worktree lookup reads from the cleanup report. */
export interface NestedWorktreeServices {
  readonly fs: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly git: GitVcsDriver["Service"];
  readonly projectRoots: ReadonlyArray<string>;
  readonly pathKey: (target: string) => string;
  readonly inside: (root: string, target: string) => boolean;
  readonly inProject: (target: string, managedRoot: string) => boolean;
}

/**
 * Linked worktrees can sit deeper inside a plain folder, like <repository>/replay/<n>. Ask the
 * projects' Git for them rather than walking folders that may hold large non-git trees.
 */
export const makeNestedWorktrees = (services: NestedWorktreeServices) => {
  const { fs, path, git, projectRoots, pathKey, inside, inProject } = services;
  let registered: ReadonlyArray<string> | undefined;
  return Effect.fnUntraced(function* (folder: string, managedRoot: string) {
    if (yield* fs.exists(path.join(folder, ".git"))) return [];
    registered ??= (yield* Effect.forEach(new Set(projectRoots), (root) =>
      git.listWorktreePaths(root).pipe(Effect.orElseSucceed((): string[] => [])),
    )).flat();
    // Locked registrations outlive their directory, whose path may since hold something else.
    return yield* Effect.filter(
      registered.filter(
        (worktree) => inside(folder, worktree) && !inProject(worktree, managedRoot),
      ),
      (worktree) =>
        Effect.gen(function* () {
          if (pathKey(yield* fs.realPath(worktree)) !== pathKey(worktree)) return false;
          return (yield* fs.stat(path.join(worktree, ".git"))).type === "File";
        }).pipe(Effect.orElseSucceed(() => false)),
    );
  });
};
