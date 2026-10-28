import * as SettingsFileChanges from "./settingsFileChanges.ts";
import { supervise } from "./backgroundSupervision.ts";
import { ServerSettingsError } from "@goat/contracts";
import { resolveSymlinkTarget } from "@goat/shared/symlink";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

export const start = Effect.fn("ServerSettingsWatcher.start")(function* (
  settingsPath: string,
  revalidate: Effect.Effect<void, ServerSettingsError>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fs
    .makeDirectory(path.dirname(settingsPath), { recursive: true })
    .pipe(
      Effect.mapError(
        (cause) => new ServerSettingsError({ settingsPath, operation: "prepare-directory", cause }),
      ),
    );
  const fileReady = yield* Deferred.make<void, ServerSettingsError>();
  const linkReady = yield* Deferred.make<void, ServerSettingsError>();
  const targetReady = yield* Deferred.make<void, ServerSettingsError>();
  const watch = yield* SettingsFileChanges.make(settingsPath);
  // Lookup failures restart the attempt so a repointed or briefly missing link is re-resolved.
  const linkTarget = resolveSymlinkTarget(settingsPath).pipe(
    Effect.provideService(FileSystem.FileSystem, fs),
    Effect.provideService(Path.Path, path),
    Effect.map((target) =>
      target === path.resolve(settingsPath) ? Option.none<string>() : Option.some(target),
    ),
    Effect.tap((target) =>
      Option.isSome(target)
        ? fs.makeDirectory(path.dirname(target.value), { recursive: true })
        : Effect.void,
    ),
  );
  const attempt = Effect.gen(function* () {
    const initial = yield* linkTarget;
    if (Option.isNone(initial)) yield* Deferred.succeed(targetReady, undefined);
    const targetEvents = Stream.make(initial).pipe(
      Stream.concat(watch(settingsPath, linkReady).pipe(Stream.mapEffect(() => linkTarget))),
      Stream.changes,
      Stream.switchMap((target) =>
        Option.match(target, {
          onNone: () => Stream.empty,
          onSome: (file) => watch(file, targetReady),
        }),
      ),
    );
    yield* Stream.merge(watch(settingsPath, fileReady), targetEvents).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach(() => revalidate),
    );
  }).pipe(
    Effect.mapError(
      (cause) => new ServerSettingsError({ settingsPath, operation: "read-file", cause }),
    ),
    Effect.onError((cause) =>
      Effect.forEach(
        [fileReady, linkReady, targetReady],
        (ready) => Deferred.failCause(ready, cause),
        { discard: true },
      ),
    ),
  );
  const supervisor = yield* supervise("ServerSettings.watch", () => attempt).pipe(
    Effect.forkScoped,
  );
  yield* Effect.all([
    Deferred.await(fileReady),
    Deferred.await(linkReady),
    Deferred.await(targetReady),
  ]).pipe(Effect.onError(() => Fiber.interrupt(supervisor)));
});
