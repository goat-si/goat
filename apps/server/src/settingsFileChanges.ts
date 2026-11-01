import { fileWatchResync, watchEndedError } from "./fileWatchResync.ts";
import { ServerSettingsError } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Stream from "effect/Stream";

export const make = Effect.fn("SettingsFileChanges.make")(function* (settingsPath: string) {
  const fs = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  return (filePath: string, ready?: Deferred.Deferred<void, ServerSettingsError>) => {
    const directory = pathService.dirname(filePath);
    const fileName = pathService.basename(filePath);
    const resolvedFilePath = pathService.resolve(filePath);
    // An undefined event marks each (re)attach so edits made while detached are reloaded.
    return fileWatchResync(
      directory,
      ready === undefined
        ? {}
        : {
            onReady: () => {
              Deferred.doneUnsafe(ready, Effect.void);
            },
          },
    ).pipe(
      Stream.provideService(FileSystem.FileSystem, fs),
      Stream.tapError((cause) =>
        ready === undefined
          ? Effect.void
          : Deferred.fail(
              ready,
              new ServerSettingsError({ settingsPath, operation: "prepare-directory", cause }),
            ),
      ),
      Stream.filter(
        (event) =>
          event === undefined ||
          event.path === fileName ||
          event.path === filePath ||
          pathService.resolve(directory, event.path) === resolvedFilePath,
      ),
      Stream.concat(
        Stream.fail(watchEndedError(filePath, "Settings filesystem watcher ended unexpectedly")),
      ),
    );
  };
});
