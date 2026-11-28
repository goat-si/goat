import type { GitCommandError } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import type { ExecuteGitResult } from "./GitVcsDriver.ts";

type ExecuteGit = (
  operation: string,
  cwd: string,
  args: readonly string[],
  options?: { timeoutMs?: number; env?: NodeJS.ProcessEnv },
) => Effect.Effect<ExecuteGitResult, GitCommandError>;

export const refreshNewWorktreeIndex = Effect.fn("refreshNewWorktreeIndex")(function* (
  worktreePath: string,
  executeGit: ExecuteGit,
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  serviceScope: Scope.Scope,
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
  const refresh = (env?: NodeJS.ProcessEnv) =>
    executeGit(
      "GitVcsDriver.createWorktree.refreshIndex",
      worktreePath,
      ["update-index", "-q", "--refresh", "--force-write-index"],
      { timeoutMs: Duration.toMillis(Duration.minutes(5)), env },
    );
  const checkoutSecond = yield* indexSecond;
  yield* refresh();
  const refreshedSecond = yield* indexSecond;
  if (
    Option.isNone(checkoutSecond) ||
    Option.isNone(refreshedSecond) ||
    refreshedSecond.value > checkoutSecond.value
  )
    return;
  const checkoutTime = checkoutSecond.value;
  const delay = (checkoutTime + 1) * 1000 + 50 - (yield* Clock.currentTimeMillis);
  if (delay >= 2_000) return;
  if (delay <= 0) return yield* refresh();
  const copyPath = `${indexPath}.goat-refresh`;
  const lockPath = `${indexPath}.lock`;
  const stamp = (info: FileSystem.File.Info) =>
    `${info.size}:${Option.getOrUndefined(info.ino)}:${Option.getOrUndefined(info.mtime)?.getTime()}`;
  yield* Effect.gen(function* () {
    yield* Effect.sleep(Duration.millis(delay));
    const copied = stamp(yield* fileSystem.stat(indexPath));
    yield* fileSystem.copyFile(indexPath, copyPath);
    yield* fileSystem.utimes(copyPath, checkoutTime, checkoutTime);
    yield* refresh({ GIT_INDEX_FILE: copyPath });
    yield* Effect.uninterruptible(
      fileSystem.link(copyPath, lockPath).pipe(
        Effect.andThen(
          fileSystem.stat(indexPath).pipe(
            Effect.flatMap((current) =>
              stamp(current) === copied
                ? fileSystem.rename(lockPath, indexPath)
                : fileSystem.remove(lockPath),
            ),
            Effect.tapError(() => fileSystem.remove(lockPath).pipe(Effect.ignore)),
          ),
        ),
      ),
    );
  }).pipe(
    Effect.ensuring(fileSystem.remove(copyPath).pipe(Effect.ignore)),
    Effect.ignore({ log: "Debug" }),
    Effect.forkIn(serviceScope),
  );
});
