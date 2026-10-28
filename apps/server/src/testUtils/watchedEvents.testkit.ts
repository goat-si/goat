import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as FileSystem from "effect/FileSystem";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

export const watchedEvents =
  (
    events: PubSub.PubSub<FileSystem.WatchEvent>,
    watching: Deferred.Deferred<void>,
    seen: Deferred.Deferred<void>,
  ): FileSystem.FileSystem["watch"] =>
  (_path, options) =>
    Stream.unwrap(
      PubSub.subscribe(events).pipe(
        Effect.tap(() =>
          Effect.sync(() => options?.onReady?.()).pipe(
            Effect.andThen(Deferred.succeed(watching, undefined)),
          ),
        ),
        Effect.map(Stream.fromSubscription),
      ),
    ).pipe(Stream.tap(() => Deferred.succeed(seen, undefined)));
