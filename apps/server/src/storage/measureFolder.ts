import * as HostProcess from "@goat/shared/HostProcess";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as ProcessRunner from "../processRunner.ts";

/**
 * Disk usage of one folder, bounded in time. POSIX hosts ask `du`, which walks a worktree of a
 * million files in seconds where a JavaScript walk takes minutes; it stays on one file system and
 * never follows links. Files pnpm shares with its store by hard link or clone are counted, so a
 * node_modules size is an upper bound of what deleting it frees.
 *
 * @module measureFolder
 */
export const measureFolder = Effect.fn("storage.measureFolder")(function* (
  target: string,
  budget: Duration.Duration,
) {
  const platform = yield* HostProcess.Platform;
  if (platform !== "win32") {
    const runner = yield* ProcessRunner.ProcessRunner;
    const output = yield* runner
      .run({
        command: "du",
        args: ["-skx", target],
        env: { LC_ALL: "C" },
        timeout: budget,
        maxOutputBytes: 1024 * 1024,
      })
      .pipe(Effect.option);
    if (Option.isNone(output)) return null;
    // du exits 1 when it could not read part of the tree; the total is then too low, not wrong.
    const kib = Number.parseInt(output.value.stdout.trim().split(/\s+/u)[0] ?? "", 10);
    return Number.isFinite(kib) && kib >= 0 ? kib * 1024 : null;
  }
  return yield* walk(target).pipe(Effect.timeoutOption(budget), Effect.map(Option.getOrNull));
});

/** Sum of file sizes below target, never following links: Windows has no du. */
const walk = Effect.fnUntraced(
  function* (target: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const pending = [target];
    let bytes = 0;
    for (let current = pending.pop(); current !== undefined; current = pending.pop()) {
      // Effect's stat follows links; a readable link is skipped, which also skips junctions.
      const isLink = yield* fs.readLink(current).pipe(
        Effect.as(true),
        Effect.orElseSucceed(() => false),
      );
      if (isLink) continue;
      const info = yield* fs.stat(current).pipe(Effect.option);
      if (Option.isNone(info)) continue;
      if (info.value.type === "File") bytes += Number(info.value.size);
      else if (info.value.type === "Directory")
        for (const name of yield* fs.readDirectory(current).pipe(Effect.orElseSucceed(() => [])))
          pending.push(path.join(current, name));
    }
    return bytes;
  },
  Effect.orElseSucceed(() => null),
);
