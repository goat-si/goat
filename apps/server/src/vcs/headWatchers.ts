import { remoteRefreshFailureDiagnostics } from "./vcsStatusDiagnostics.ts";
import type { GitManagerServiceError } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as SynchronizedRef from "effect/SynchronizedRef";

// A held index.lock fails the read, and its removal moves no HEAD to trigger another.
const CHECKOUT_REFRESH_RETRY = Schedule.exponential(Duration.seconds(1)).pipe(
  Schedule.modifyDelay(({ duration }) =>
    Effect.succeed(Duration.min(duration, Duration.seconds(30))),
  ),
);

interface ActiveHeadWatcher {
  readonly fiber: Fiber.Fiber<void, never>;
  readonly ready: Deferred.Deferred<void>;
  readonly subscriberCount: number;
}

export const makeHeadWatchers = Effect.fn("VcsStatusBroadcaster.makeHeadWatchers")(function* (
  broadcasterScope: Scope.Scope,
  headPathFor: (cwd: string) => Effect.Effect<string | null>,
  refreshCheckedOutRef: (cwd: string) => Effect.Effect<void, GitManagerServiceError>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const headWatchersRef = yield* SynchronizedRef.make(new Map<string, ActiveHeadWatcher>());
  // Runs for the subscription lifetime, so tracing would leave a span open indefinitely.
  const watchHead = Effect.fnUntraced(function* (cwd: string, ready: Deferred.Deferred<void>) {
    const headPath = yield* headPathFor(cwd);
    if (headPath === null) return;
    const headDirectory = path.dirname(headPath);
    // Git replaces HEAD by renaming HEAD.lock, which a watch on the file itself would lose.
    yield* fs
      .watch(headDirectory, {
        onReady: () => Deferred.doneUnsafe(ready, Exit.void),
      })
      .pipe(
        // Windows can keep reporting removals after the watched directory is gone.
        Stream.mapEffect((event) =>
          event._tag === "Remove"
            ? fs.exists(headDirectory).pipe(Effect.map((exists) => ({ event, removed: !exists })))
            : Effect.succeed({ event, removed: false }),
        ),
        Stream.takeUntil(({ removed }) => removed),
        Stream.filter(({ event, removed }) => removed || path.basename(event.path) === "HEAD"),
        // A rebase moves HEAD many times; refresh once for whatever arrived during a refresh.
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.runForEach(() =>
          refreshCheckedOutRef(cwd).pipe(
            Effect.retry(CHECKOUT_REFRESH_RETRY),
            Effect.catchCause((cause) =>
              Effect.logWarning("VCS checked-out ref refresh failed", {
                cwdLength: cwd.length,
                ...remoteRefreshFailureDiagnostics(cause),
              }),
            ),
          ),
        ),
      );
  });

  const retainHeadWatcher = Effect.fn("VcsStatusBroadcaster.retainHeadWatcher")(function* (
    cwd: string,
  ) {
    const ready = yield* SynchronizedRef.modifyEffect(headWatchersRef, (activeWatchers) => {
      const existing = activeWatchers.get(cwd);
      if (existing && existing.fiber.pollUnsafe() === undefined) {
        const nextWatchers = new Map(activeWatchers).set(cwd, {
          ...existing,
          subscriberCount: existing.subscriberCount + 1,
        });
        return Effect.succeed([existing.ready, nextWatchers] as const);
      }
      // A watch that ended, say before the repository existed, restarts for everyone holding it.
      return Effect.gen(function* () {
        const ready = yield* Deferred.make<void>();
        const fiber = yield* watchHead(cwd, ready).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("VCS HEAD watch failed", {
              cwdLength: cwd.length,
              ...remoteRefreshFailureDiagnostics(cause),
            }),
          ),
          // Subscribers wait for the watch, so one that cannot start must not hold them.
          Effect.ensuring(Deferred.succeed(ready, undefined)),
          Effect.forkIn(broadcasterScope),
        );
        const nextWatchers = new Map(activeWatchers).set(cwd, {
          fiber,
          ready,
          subscriberCount: (existing?.subscriberCount ?? 0) + 1,
        });
        return [ready, nextWatchers] as const;
      });
    });
    yield* Deferred.await(ready);
  });

  const releaseHeadWatcher = Effect.fn("VcsStatusBroadcaster.releaseHeadWatcher")(function* (
    cwd: string,
  ) {
    const watcherToInterrupt = yield* SynchronizedRef.modify(headWatchersRef, (activeWatchers) => {
      const existing = activeWatchers.get(cwd);
      if (!existing) return [null, activeWatchers] as const;
      const nextWatchers = new Map(activeWatchers);
      if (existing.subscriberCount > 1) {
        nextWatchers.set(cwd, { ...existing, subscriberCount: existing.subscriberCount - 1 });
        return [null, nextWatchers] as const;
      }
      nextWatchers.delete(cwd);
      return [existing.fiber, nextWatchers] as const;
    });
    if (watcherToInterrupt) {
      yield* Fiber.interrupt(watcherToInterrupt).pipe(Effect.ignore);
    }
  });

  return (cwd: string) =>
    Effect.acquireRelease(retainHeadWatcher(cwd), () => releaseHeadWatcher(cwd));
});
