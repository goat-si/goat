// @effect-diagnostics nodeBuiltinImport:off - FileSystem.readDirectory buffers the entire directory; opendir bounds the sweep.
import * as NodeFSP from "node:fs/promises";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

/** Live runtimes whose directories the sweep must skip; past this a new runtime is refused. */
export const MAX_LIVE_ANTIGRAVITY_RUNTIMES = 256;
const runtimeTempGate = Semaphore.makeUnsafe(1);
const liveRuntimeDirectories = new Set<string>();

export const acquireAntigravityRuntimeTemp = Effect.fn("acquireAntigravityRuntimeTemp")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* Effect.acquireRelease(
    runtimeTempGate.withPermits(1)(
      Effect.gen(function* () {
        if (liveRuntimeDirectories.size >= MAX_LIVE_ANTIGRAVITY_RUNTIMES) {
          return yield* PlatformError.systemError({
            _tag: "Busy",
            module: "AntigravitySessionFiles",
            method: "acquireAntigravityRuntimeTemp",
            description: "Too many Antigravity sessions are running. Close one and try again.",
          });
        }
        yield* fs.makeDirectory(root, { recursive: true });
        const directory = yield* fs.makeTempDirectory({ directory: root, prefix: "run-" });
        liveRuntimeDirectories.add(directory);
        return directory;
      }),
    ),
    (directory) =>
      runtimeTempGate.withPermits(1)(
        fs.remove(directory, { recursive: true, force: true }).pipe(
          Effect.catch(() =>
            Effect.logWarning("Could not remove an Antigravity runtime temp directory."),
          ),
          Effect.ensuring(
            Effect.sync(() => {
              liveRuntimeDirectories.delete(directory);
            }),
          ),
        ),
      ),
  );
});

const isNativeSessionId = Schema.is(Schema.String.check(Schema.isUUID(4)));
const decodeSessionMetadata = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Struct({ cwd: Schema.String })),
);

/** Call after the process closes. The unique temporary cwd proves which session we own. */
export const removeAntigravitySessionFiles = Effect.fn("removeAntigravitySessionFiles")(
  function* (input: {
    readonly profileDirectory: string;
    readonly sessionId: string | undefined;
    readonly cwd: string;
  }) {
    if (input.sessionId === undefined || !isNativeSessionId(input.sessionId)) {
      return;
    }
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const acpDirectory = path.join(input.profileDirectory, "antigravity-acp");
    const base = path.join(acpDirectory, "conversations", input.sessionId);
    if (!(yield* fs.exists(`${base}.meta`))) {
      return;
    }
    const metadata = yield* fs
      .readFileString(`${base}.meta`)
      .pipe(Effect.flatMap(decodeSessionMetadata));
    if (metadata.cwd !== input.cwd) {
      return;
    }
    for (const suffix of [".db", ".db-wal", ".db-shm", ".db-journal", ".meta"]) {
      yield* fs.remove(`${base}${suffix}`, { force: true });
    }
    yield* fs.remove(path.join(acpDirectory, "brain", input.sessionId), {
      recursive: true,
      force: true,
    });
  },
  Effect.catch(() => Effect.logWarning("Could not remove temporary Antigravity session files.")),
);

const warnRuntimeTempLeftovers = Effect.logWarning(
  "Could not remove leftover Antigravity runtime temp files.",
);

/**
 * Sweep only private runtimes before launch; Windows does not protect live extracted data files from deletion.
 * Moves leftovers aside and returns their slow deletion (seconds on Windows) to run off the startup path.
 */
export const retireAntigravityRuntimeTempDirs = Effect.fn("retireAntigravityRuntimeTempDirs")(
  function* (tempDirectory: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const parent = path.dirname(tempDirectory);
    const prefix = `${path.basename(tempDirectory)}.old-`;
    const entries = yield* runtimeTempGate.withPermits(1)(
      Effect.gen(function* () {
        if (yield* fs.exists(tempDirectory)) {
          const hasLive = Array.from(liveRuntimeDirectories).some(
            (directory) => path.dirname(directory) === tempDirectory,
          );
          if (!hasLive) {
            yield* fs.makeTempDirectory({ directory: parent, prefix }).pipe(
              Effect.flatMap((retired) => fs.rename(tempDirectory, path.join(retired, "runtime"))),
              Effect.catch(() => fs.remove(tempDirectory, { recursive: true, force: true })),
            );
          } else {
            const children = yield* Effect.tryPromise(() => listDirectoryEntries(tempDirectory));
            const retired = yield* fs.makeTempDirectory({ directory: parent, prefix });
            for (const entry of children) {
              const source = path.join(tempDirectory, entry);
              if (!liveRuntimeDirectories.has(source)) {
                yield* fs
                  .rename(source, path.join(retired, entry))
                  .pipe(Effect.catch(() => warnRuntimeTempLeftovers));
              }
            }
          }
        }
        return yield* Effect.tryPromise(() => listRetiredDirectories(parent, prefix)).pipe(
          Effect.orElseSucceed(() => [] as string[]),
        );
      }),
    );
    return Effect.forEach(
      entries,
      (entry) =>
        fs
          .remove(path.join(parent, entry), { recursive: true, force: true })
          .pipe(Effect.catch(() => warnRuntimeTempLeftovers)),
      { discard: true },
    );
  },
  Effect.catch(() => warnRuntimeTempLeftovers.pipe(Effect.as(Effect.void))),
);

async function listDirectoryEntries(directoryPath: string): Promise<string[]> {
  const directory = await NodeFSP.opendir(directoryPath);
  const entries: string[] = [];
  for await (const entry of directory) {
    entries.push(entry.name);
    if (entries.length === 1_024) break;
  }
  return entries;
}

async function listRetiredDirectories(parent: string, prefix: string): Promise<string[]> {
  const directory = await NodeFSP.opendir(parent);
  const entries: string[] = [];
  let scanned = 0;
  for await (const entry of directory) {
    if (++scanned > 1_024) break;
    if (entry.name.startsWith(prefix)) entries.push(entry.name);
    if (entries.length === 32) break;
  }
  return entries;
}
