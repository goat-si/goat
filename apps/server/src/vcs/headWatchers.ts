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
import * as KeyedLock from "@goat/shared/KeyedLock";

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
  publishCheckedOutRef: (cwd: string) => Effect.Effect<void, GitManagerServiceError>,
  reconcileCheckedOutRef: (cwd: string) => Effect.Effect<void, GitManagerServiceError>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const locks = yield* KeyedLock.make<string>();
  const activeWatchers = new Map<string, ActiveHeadWatcher>();
  const retryCheckoutRefresh = (
    cwd: string,
    refresh: Effect.Effect<void, GitManagerServiceError>,
  ) =>
    refresh.pipe(
      Effect.retry(CHECKOUT_REFRESH_RETRY),
      Effect.catchCause((cause) =>
        Effect.logWarning("VCS checked-out ref refresh failed", {
          cwdLength: cwd.length,
          ...remoteRefreshFailureDiagnostics(cause),
        }),
      ),
    );

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
          Effect.gen(function* () {
            const removed = event._tag === "Remove" && !(yield* fs.exists(headDirectory));
            return { event, removed };
          }),
        ),
        Stream.takeUntil(({ removed }) => removed),
        Stream.filter(({ event, removed }) => removed || path.basename(event.path) === "HEAD"),
        // A rebase moves HEAD many times; refresh once for whatever arrived during a refresh.
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.mapEffect(() => retryCheckoutRefresh(cwd, publishCheckedOutRef(cwd))),
        Stream.buffer({ capacity: 1, strategy: "sliding" }),
        Stream.runForEach(() => retryCheckoutRefresh(cwd, reconcileCheckedOutRef(cwd))),
      );
  });

  const retainHeadWatcher = Effect.fn("VcsStatusBroadcaster.retainHeadWatcher")(function* (
    cwd: string,
  ) {
    const ready = yield* locks.withLock(
      cwd,
      Effect.gen(function* () {
        const existing = activeWatchers.get(cwd);
        if (existing && existing.fiber.pollUnsafe() === undefined) {
          activeWatchers.set(cwd, { ...existing, subscriberCount: existing.subscriberCount + 1 });
          return existing.ready;
        }
        // An ended watch restarts for every remaining subscriber.
        const ready = yield* Deferred.make<void>();
        const fiber = yield* watchHead(cwd, ready).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("VCS HEAD watch failed", {
              cwdLength: cwd.length,
              ...remoteRefreshFailureDiagnostics(cause),
            }),
          ),
          Effect.ensuring(Deferred.succeed(ready, undefined)),
          Effect.forkIn(broadcasterScope),
        );
        activeWatchers.set(cwd, {
          fiber,
          ready,
          subscriberCount: (existing?.subscriberCount ?? 0) + 1,
        });
        return ready;
      }),
    );
    yield* Deferred.await(ready);
  });

  const releaseHeadWatcher = Effect.fn("VcsStatusBroadcaster.releaseHeadWatcher")((cwd: string) =>
    locks.withLock(
      cwd,
      Effect.gen(function* () {
        const existing = activeWatchers.get(cwd);
        if (!existing) return;
        if (existing.subscriberCount > 1) {
          activeWatchers.set(cwd, { ...existing, subscriberCount: existing.subscriberCount - 1 });
          return;
        }
        yield* Fiber.interrupt(existing.fiber);
        activeWatchers.delete(cwd);
      }),
    ),
  );

  return (cwd: string) =>
    Effect.acquireRelease(retainHeadWatcher(cwd), () => releaseHeadWatcher(cwd));
});
