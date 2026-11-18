import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

/** Preserve input-invalidated Gradle/.cxx caches; exclude app/build because its tasks omit inputs. Ignore cache failures. */
export const prebuildAndroid = Effect.fn("nativeClient.prebuildAndroid")(function* <E, R>(
  mobile: string,
  prebuild: Effect.Effect<void, E, R>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const android = path.join(mobile, "android");
  // Sibling renames stay on one filesystem; interrupted runs leave this gitignored cache for next-run cleanup.
  const saved = path.join(mobile, ".android-cache");
  const caches = [".gradle", "app/.cxx"];
  const clear = fs.remove(saved, { recursive: true, force: true }).pipe(Effect.ignore);
  const move = (from: string, to: string) =>
    Effect.forEach(
      caches,
      (cache) =>
        Effect.gen(function* () {
          const source = path.join(from, cache);
          const target = path.join(to, cache);
          if (!(yield* fs.exists(source)) || (yield* fs.exists(target))) return;
          yield* fs.makeDirectory(path.dirname(target), { recursive: true });
          yield* fs.rename(source, target);
        }).pipe(Effect.ignore),
      { discard: true },
    );
  yield* Effect.acquireUseRelease(
    clear.pipe(Effect.andThen(move(android, saved))),
    () => prebuild,
    () => move(saved, android).pipe(Effect.andThen(clear)),
  );
});
