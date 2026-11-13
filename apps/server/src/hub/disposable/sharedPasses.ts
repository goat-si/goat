import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

/**
 * Runs one pass per key at a time in the given scope: a caller that arrives while the key's pass
 * runs waits for that pass instead of starting another. A pass never fails its waiters; its failures
 * and defects are logged, so a background loop built on it keeps running.
 */
export const makeSharedPasses = (scope: Scope.Scope, limit: number) => {
  const running = new Map<string, Deferred.Deferred<void>>();
  return <E>(key: string, pass: Effect.Effect<void, E>) =>
    // Storing the key and forking the pass that clears it happen with no interruption between
    // them; otherwise an interrupted caller would leave the key waiting forever. The pass itself
    // stays interruptible, so closing the scope still stops it.
    Effect.uninterruptibleMask((restore) =>
      Effect.suspend(() => {
        const current = running.get(key);
        if (current !== undefined) return Effect.succeed(current);
        const done = Deferred.makeUnsafe<void>();
        if (running.size >= limit) return Effect.as(Deferred.succeed(done, undefined), done);
        running.set(key, done);
        return restore(pass).pipe(
          Effect.catchCause((cause) =>
            Cause.hasInterruptsOnly(cause)
              ? Effect.void
              : Effect.logWarning("Disposable machine reconcile failed", Cause.squash(cause)),
          ),
          Effect.ensuring(
            Effect.suspend(() => {
              running.delete(key);
              return Deferred.succeed(done, undefined);
            }),
          ),
          Effect.forkIn(scope),
          Effect.as(done),
        );
      }),
    );
};
