import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { VcsCheckpointStorageError } from "@goat/contracts";
import { quoteGitPatchPath } from "@goat/shared/gitPatchPath";

// The enclosing capture span owns this scope and its temporary objects.
export const privateCheckpointObjects = Effect.fnUntraced(function* (
  fileSystem: FileSystem.FileSystem,
  path: Path.Path,
  gitCommonDir: string,
  cwd: string,
  operation: string,
) {
  const sharedObjects = path.join(gitCommonDir, "objects");
  const privateObjects = yield* Effect.acquireRelease(
    fileSystem
      .makeTempDirectory({ directory: sharedObjects, prefix: "tmp_objdir-goat-checkpoint-" })
      .pipe(
        Effect.mapError(
          (cause) => new VcsCheckpointStorageError({ operation, cwd, stage: "isolate", cause }),
        ),
      ),
    (directory) =>
      fileSystem
        .remove(directory, { recursive: true, force: true })
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not remove private checkpoint objects", {
              reason: cause.reason._tag,
            }),
          ),
        ),
  );
  yield* fileSystem
    .makeDirectory(path.join(privateObjects, "pack"))
    .pipe(
      Effect.mapError(
        (cause) => new VcsCheckpointStorageError({ operation, cwd, stage: "isolate", cause }),
      ),
    );
  const quotedObjects = quoteGitPatchPath(sharedObjects);
  const env = {
    GIT_OBJECT_DIRECTORY: privateObjects,
    GIT_QUARANTINE_PATH: privateObjects,
    GIT_ALTERNATE_OBJECT_DIRECTORIES: quotedObjects.startsWith('"')
      ? quotedObjects
      : `"${quotedObjects}"`,
  };
  const publish = Effect.fn("GitVcsDriver.publishCheckpointObjects")(function* () {
    yield* fileSystem.readDirectory(privateObjects).pipe(
      Effect.flatMap((directories) =>
        Effect.forEach(
          directories.filter(
            (directory) => directory === "pack" || /^[0-9a-f]{2}$/.test(directory),
          ),
          (directory) =>
            Effect.gen(function* () {
              const source = path.join(privateObjects, directory);
              const destination = path.join(sharedObjects, directory);
              // Most fanouts already exist; avoid constructing an EEXIST error
              // for each of them on every capture. mkdir still handles the race.
              if (!(yield* fileSystem.exists(destination)))
                yield* fileSystem.makeDirectory(destination).pipe(
                  Effect.andThen(
                    Effect.gen(function* () {
                      // Git has already applied core.sharedRepository to the source.
                      // chmod bypasses umask, but never changes a pre-existing bucket.
                      const { mode } = yield* fileSystem.stat(source);
                      yield* fileSystem.chmod(destination, mode & 0o7777);
                    }),
                  ),
                  Effect.catchIf(
                    (cause) => cause.reason._tag === "AlreadyExists",
                    () => Effect.void,
                  ),
                  Effect.uninterruptible,
                );
              const names = yield* fileSystem.readDirectory(source);
              // Per-object spans would swamp the capture span for large workspaces.
              const linkObject = Effect.fnUntraced(function* (name: string) {
                const from = path.join(source, name);
                const to = path.join(destination, name);
                yield* fileSystem.link(from, to).pipe(
                  Effect.catchIf(
                    (cause) =>
                      cause.reason._tag === "PermissionDenied" || cause.reason._tag === "Unknown",
                    () =>
                      Effect.gen(function* () {
                        if (yield* fileSystem.exists(to)) return;
                        // Git also falls back to rename without hardlinks; identical object names are interchangeable.
                        yield* fileSystem.rename(from, to);
                      }),
                  ),
                  Effect.catchIf(
                    (cause) => cause.reason._tag === "AlreadyExists",
                    () => Effect.void,
                  ),
                );
              });
              if (directory !== "pack") {
                yield* Effect.forEach(
                  names.filter((name) => /^(?:[0-9a-f]{38}|[0-9a-f]{62})$/.test(name)),
                  linkObject,
                  { discard: true },
                );
                return;
              }
              const files = new Set(names);
              for (const name of names) {
                if (!/^pack-(?:[0-9a-f]{40}|[0-9a-f]{64})\.pack$/.test(name)) continue;
                const base = name.slice(0, -5);
                if (!files.has(`${base}.idx`)) continue;
                // Link metadata before the pack so an I/O error cannot strand a
                // large unindexed pack. Defer cancellation across this short group
                // of links. Never roll back shared links: a concurrent writer may
                // already depend on them. Ref publication still happens last.
                yield* Effect.forEach(
                  [".keep", ".promisor", ".rev", ".idx", ".pack"]
                    .map((extension) => `${base}${extension}`)
                    .filter((file) => files.has(file)),
                  linkObject,
                  { discard: true },
                ).pipe(Effect.uninterruptible);
              }
            }),
          { concurrency: 16, discard: true },
        ),
      ),
      Effect.mapError(
        (cause) => new VcsCheckpointStorageError({ operation, cwd, stage: "publish", cause }),
      ),
    );
  });
  return { env, publish };
});
