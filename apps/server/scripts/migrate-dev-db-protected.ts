import * as HostProcess from "@goat/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

// The real path of the deepest existing ancestor plus the missing tail: below
// that ancestor nothing exists yet, so no link can redirect the rest.
const canonicalPath = Effect.fn("migrateDevDb.canonicalPath")(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const tail: Array<string> = [];
  let existing = target;
  while (!(yield* fs.exists(existing)) && path.dirname(existing) !== existing) {
    tail.unshift(path.basename(existing));
    existing = path.dirname(existing);
  }
  const resolved = yield* fs.realPath(existing).pipe(Effect.orElseSucceed(() => existing));
  return path.join(resolved, ...tail);
});

// Device and inode follow links and ignore how a name is cased. A missing
// directory, or one without an inode, falls back to its canonical path, which
// ignores case where the filesystem usually does.
const directoryIdentity = Effect.fn("migrateDevDb.directoryIdentity")(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(target).pipe(Effect.option);
  const ino = Option.isSome(info) ? Option.getOrUndefined(info.value.ino) : undefined;
  if (Option.isSome(info) && ino !== undefined && ino !== 0n) return `${info.value.dev}:${ino}`;
  const canonical = yield* canonicalPath(target);
  const platform = yield* HostProcess.Platform;
  return `path:${platform === "darwin" || platform === "win32" ? canonical.toLowerCase() : canonical}`;
});

/**
 * Whether a destination is a protected home itself or lies inside its live
 * userdata, whether or not those exist yet. The walk follows the destination's
 * canonical path, so a link that points anywhere into live state is caught.
 * Siblings such as <home>/dev stay usable as dev homes.
 */
export const isProtectedDestination = Effect.fn("migrateDevDb.isProtectedDestination")(function* (
  baseDir: string,
  protectedHomes: ReadonlyArray<string>,
) {
  const path = yield* Path.Path;
  const baseIdentity = yield* directoryIdentity(baseDir);
  const ancestors = new Set<string>();
  for (let directory = yield* canonicalPath(baseDir); ; directory = path.dirname(directory)) {
    ancestors.add(yield* directoryIdentity(directory));
    if (path.dirname(directory) === directory) break;
  }
  for (const home of protectedHomes) {
    if (
      (yield* directoryIdentity(home)) === baseIdentity ||
      ancestors.has(yield* directoryIdentity(path.join(home, "userdata")))
    ) {
      return true;
    }
  }
  return false;
});
