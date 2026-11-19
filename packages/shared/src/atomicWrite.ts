import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import type * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import * as HostProcess from "@goat/shared/HostProcess";
import { resolveSymlinkTarget } from "@goat/shared/symlink";

/** Windows open-file locks block renames; the same codes can mean permanent denial, so bound retries. */
export const isWindowsRenameLock = (error: PlatformError.PlatformError) => {
  const code = (error.reason.cause as NodeJS.ErrnoException | undefined)?.code;
  return code === "EBUSY" || code === "EPERM" || code === "EACCES";
};

// Bound denial delays to about two seconds because settings saves hold their write lock.
const LOCKED_RENAME_RETRIES = 20;
const LOCKED_RENAME_RETRY_DELAY = "100 millis";
const CHUNK_WRITE_LENGTH = 1 << 20;

/** Preserves symlinks by default. Iterable contents stream in bounded batches. */
export const writeFileStringAtomically = (input: {
  readonly filePath: string;
  readonly contents: string | Iterable<string>;
  /** Requires an exclusive writer and reserves the destination's `.staging` sibling. */
  readonly reuseStagingFile?: true;
  /** Stages beside the configured path and renames over a symlink at that path. */
  readonly replaceSymlink?: true;
}) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const platform = yield* HostProcess.Platform;
      const targetPath = input.replaceSymlink
        ? path.resolve(input.filePath)
        : yield* resolveSymlinkTarget(input.filePath);
      const targetDirectory = path.dirname(targetPath);

      yield* fs.makeDirectory(targetDirectory, { recursive: true });
      const stagingOptions = input.reuseStagingFile
        ? ({ flag: "wx", mode: 0o600 } as const)
        : undefined;
      const stagingPath = `${targetPath}.staging`;
      // Cleanup failure must not fail a write that already landed.
      const tempPath = stagingOptions
        ? yield* Effect.acquireRelease(
            fs.remove(stagingPath, { force: true }).pipe(Effect.as(stagingPath)),
            (file) => fs.remove(file, { force: true }).pipe(Effect.ignore({ log: true })),
          )
        : path.join(
            yield* Effect.acquireRelease(
              fs.makeTempDirectory({
                directory: targetDirectory,
                prefix: "goat-write-",
              }),
              (directory) =>
                fs.remove(directory, { recursive: true }).pipe(Effect.ignore({ log: true })),
            ),
            "contents.tmp",
          );

      const contents = input.contents;
      if (typeof contents === "string") {
        yield* fs.writeFileString(tempPath, contents, stagingOptions);
      } else {
        // Closed before the rename, which Windows refuses for open files.
        yield* Effect.scoped(
          Effect.gen(function* () {
            const file = yield* fs.open(tempPath, stagingOptions ?? { flag: "w" });
            const encoder = new TextEncoder();
            let batch: string[] = [];
            let batchLength = 0;
            for (const chunk of contents) {
              batch.push(chunk);
              batchLength += chunk.length;
              if (batchLength < CHUNK_WRITE_LENGTH) continue;
              yield* file.writeAll(encoder.encode(batch.join("")));
              batch = [];
              batchLength = 0;
            }
            if (batchLength > 0) yield* file.writeAll(encoder.encode(batch.join("")));
          }),
        );
      }
      if (platform !== "win32") return yield* fs.rename(tempPath, targetPath);

      // Stop retrying if another save changes the target; read-only targets also return permanent EPERM.
      const targetVersion = (
        input.replaceSymlink ? fs.lstat(targetPath) : fs.stat(targetPath)
      ).pipe(
        Effect.map((info) => ({
          id: `${Option.getOrUndefined(info.ino)}:${info.size}:${Option.getOrUndefined(info.mtime)?.getTime()}`,
          readOnly: (info.mode & 0o200) === 0,
        })),
        Effect.catchIf(
          (error) => error.reason._tag === "NotFound",
          () => Effect.succeed({ id: "missing", readOnly: false }),
        ),
        Effect.option,
      );
      const before = yield* targetVersion;
      const firstAttempt = yield* Effect.result(fs.rename(tempPath, targetPath));
      if (Result.isSuccess(firstAttempt)) return;
      const lockError = firstAttempt.failure;
      if (!isWindowsRenameLock(lockError) || Option.isNone(before) || before.value.readOnly) {
        return yield* lockError;
      }
      for (let retry = 0; retry < LOCKED_RENAME_RETRIES; retry += 1) {
        yield* Effect.sleep(LOCKED_RENAME_RETRY_DELAY);
        const current = yield* targetVersion;
        if (Option.isNone(current) || current.value.id !== before.value.id) break;
        const attempt = yield* Effect.result(fs.rename(tempPath, targetPath));
        if (Result.isSuccess(attempt)) return;
        if (!isWindowsRenameLock(attempt.failure)) return yield* attempt.failure;
      }
      return yield* lockError;
    }),
  );
