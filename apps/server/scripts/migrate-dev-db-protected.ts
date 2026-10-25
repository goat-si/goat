import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

// Device and inode follow links and ignore how a name is cased. Without an
// inode, the resolved real path still sees through links.
const directoryIdentity = Effect.fn("migrateDevDb.directoryIdentity")(function* (target: string) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(target).pipe(Effect.option);
  if (Option.isNone(info)) return undefined;
  const ino = Option.getOrUndefined(info.value.ino);
  if (ino !== undefined && ino !== 0n) return `${info.value.dev}:${ino}`;
  return `path:${yield* fs.realPath(target).pipe(Effect.orElseSucceed(() => target))}`;
});

/**
 * Whether a destination is a protected home itself or lies inside its live
 * userdata. The walk starts from the real path of the deepest existing
 * ancestor, so a link that points anywhere into live state is caught.
 * Siblings such as <home>/dev stay usable as dev homes.
 */
export const isProtectedDestination = Effect.fn("migrateDevDb.isProtectedDestination")(function* (
  baseDir: string,
  protectedHomes: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  let existing = baseDir;
  while (!(yield* fs.exists(existing)) && path.dirname(existing) !== existing) {
    existing = path.dirname(existing);
  }
  const baseIdentity = yield* directoryIdentity(baseDir);
  const ancestors = new Set<string>();
  let directory = yield* fs.realPath(existing).pipe(Effect.orElseSucceed(() => existing));
  for (;;) {
    const identity = yield* directoryIdentity(directory);
    if (identity !== undefined) ancestors.add(identity);
    if (path.dirname(directory) === directory) break;
    directory = path.dirname(directory);
  }
  for (const home of protectedHomes) {
    const homeIdentity = yield* directoryIdentity(home);
    const liveIdentity = yield* directoryIdentity(path.join(home, "userdata"));
    if (
      (homeIdentity !== undefined && homeIdentity === baseIdentity) ||
      (liveIdentity !== undefined && ancestors.has(liveIdentity))
    ) {
      return true;
    }
  }
  return false;
});
