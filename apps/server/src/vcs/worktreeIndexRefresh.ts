import type { GitCommandError } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type { ExecuteGitResult } from "./GitVcsDriver.ts";

type ExecuteGit = (
  operation: string,
  cwd: string,
  args: readonly string[],
  options?: { timeoutMs?: number },
) => Effect.Effect<ExecuteGitResult, GitCommandError>;

export const refreshNewWorktreeIndex = Effect.fn("refreshNewWorktreeIndex")(function* (
  worktreePath: string,
  executeGit: ExecuteGit,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
) {
  const indexPath = path.resolve(
    worktreePath,
    (yield* executeGit("GitVcsDriver.createWorktree.indexPath", worktreePath, [
      "rev-parse",
      "--git-path",
      "index",
    ])).stdout.trim(),
  );
  const indexSecond = fileSystem.stat(indexPath).pipe(
    Effect.map(({ mtime }) => Option.map(mtime, (date) => Math.floor(date.getTime() / 1000))),
    Effect.orElseSucceed(() => Option.none<number>()),
  );
  const refresh = executeGit(
    "GitVcsDriver.createWorktree.refreshIndex",
    worktreePath,
    ["update-index", "-q", "--refresh", "--force-write-index"],
    { timeoutMs: Duration.toMillis(Duration.minutes(5)) },
  );
  const checkoutSecond = yield* indexSecond;
  yield* refresh;
  const refreshedSecond = yield* indexSecond;
  if (
    Option.isNone(checkoutSecond) ||
    Option.isNone(refreshedSecond) ||
    refreshedSecond.value > checkoutSecond.value
  )
    return;
  // A same-second refresh leaves Git's racily-clean entries unchanged.
  const delay = (checkoutSecond.value + 1) * 1000 + 50 - (yield* Clock.currentTimeMillis);
  if (delay >= 2_000) return;
  if (delay > 0) yield* Effect.sleep(Duration.millis(delay));
  yield* refresh;
});
