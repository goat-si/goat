import type { ProviderSessionId } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Scope from "effect/Scope";

/**
 * Closes provider session scopes within a bound. A close can wedge on a misbehaving
 * adapter finalizer (e.g. a provider process that never yields its message stream),
 * so one that outlives its wait keeps running detached.
 *
 * Effect detaches a scope from its parent as soon as its close starts, so closing the
 * parent does not wait for a close already under way. `awaitPendingReleases` does, so a
 * shutdown does not finish while a released agent is still exiting; on Windows that
 * agent's cwd cannot be removed until then.
 */
export const makeScopeCloser = (timeoutMs: number) => {
  const pending = new Set<Fiber.Fiber<Exit.Exit<void>>>();
  // Releases count from before they remove their session: in between, neither the
  // session map nor `pending` shows them to a shutdown.
  const releases = new Set<Deferred.Deferred<void>>();

  const trackRelease = <A, E, R>(release: Effect.Effect<A, E, R>) =>
    Effect.suspend(() => {
      const done = Deferred.makeUnsafe<void>();
      releases.add(done);
      return release.pipe(
        Effect.ensuring(
          Effect.suspend(() => {
            releases.delete(done);
            return Deferred.succeed(done, undefined);
          }),
        ),
      );
    });

  const closeWithin = Effect.fn("ProviderSessionManager.closeScopeWithin")(function* (
    scope: Scope.Closeable,
    annotations: { readonly providerSessionId?: ProviderSessionId; readonly reason: string },
  ) {
    const closeFiber = yield* Scope.close(scope, Exit.void).pipe(
      Effect.exit,
      Effect.forkDetach({ startImmediately: true }),
    );
    pending.add(closeFiber);
    closeFiber.addObserver(() => pending.delete(closeFiber));
    const closeExit = yield* Fiber.join(closeFiber).pipe(Effect.timeoutOption(timeoutMs));
    if (Option.isNone(closeExit)) {
      yield* Effect.logWarning("orchestration-v2.provider-session-scope-close-timeout", {
        ...annotations,
        timeoutMs,
      });
      yield* Fiber.join(closeFiber).pipe(
        Effect.flatMap((exit) =>
          Exit.isFailure(exit)
            ? Effect.logWarning("orchestration-v2.provider-session-scope-close-failed", {
                ...annotations,
                cause: exit.cause,
              })
            : Effect.logInfo(
                "orchestration-v2.provider-session-scope-close-completed-late",
                annotations,
              ),
        ),
        Effect.forkDetach,
      );
    }
    return closeExit;
  });

  // A release that was still removing its session may start its close while this
  // waits, so it waits again until nothing is left.
  const awaitSettled: Effect.Effect<void> = Effect.suspend(() => {
    const closes = [...pending];
    const running = [...releases];
    if (closes.length === 0 && running.length === 0) return Effect.void;
    return Effect.all(
      [
        Fiber.awaitAll(closes),
        Effect.forEach(running, Deferred.await, { concurrency: "unbounded", discard: true }),
      ],
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.andThen(awaitSettled));
  });

  /** Waits, within the same bound, for every release and close still running. */
  const awaitPendingReleases = awaitSettled.pipe(Effect.timeoutOption(timeoutMs), Effect.asVoid);

  return { closeWithin, trackRelease, awaitPendingReleases };
};
