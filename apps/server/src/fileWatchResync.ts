import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stream from "effect/Stream";

export const fileWatchResync = (directory: string, options: FileSystem.WatchOptions = {}) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const ready = yield* Deferred.make<void>();
      const events = fs.watch(directory, {
        ...options,
        onReady: () => {
          Deferred.doneUnsafe(ready, Effect.void);
          options.onReady?.();
        },
      });
      return Stream.merge(
        Stream.fromEffect(Deferred.await(ready).pipe(Effect.as(undefined))),
        events,
        { haltStrategy: "right" },
      );
    }),
  );
