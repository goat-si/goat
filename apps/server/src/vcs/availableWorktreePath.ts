import { GitCommandError } from "@goat/contracts";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";

export const availableWorktreePath = Effect.fn("GitVcsDriver.availableWorktreePath")(function* (
  fs: FileSystem.FileSystem,
  cwd: string,
  base: string,
) {
  let candidate = base;
  let suffix = 2;
  while (
    yield* fs.exists(candidate).pipe(
      Effect.mapError(
        (cause) =>
          new GitCommandError({
            operation: "GitVcsDriver.createWorktree",
            command: "git worktree add",
            cwd,
            detail: "Could not inspect the worktree destination.",
            cause,
          }),
      ),
    )
  )
    candidate = `${base}-${suffix++}`;
  return candidate;
});
