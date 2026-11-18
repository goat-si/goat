import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

/**
 * Runs `body` as a server-owned job once the caller holds `permit`, so a caller gone before its
 * turn leaves no job and one permit means one job at a time. The caller leaving does not interrupt
 * the started body (its own timeouts and closing `serviceScope` still do); `stopped` says the caller
 * left, so the body finishes what is under way and starts nothing new.
 */
// Untraced: the OpenCodexSync.run and HubMembership.move spans already trace each job.
export const runAsServerJob = Effect.fnUntraced(function* <A, E, R>(
  permit: Semaphore.Semaphore,
  serviceScope: Scope.Scope,
  job: string,
  body: (stopped: Effect.Effect<boolean>) => Effect.Effect<A, E, R>,
) {
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      let stopped = false;
      // The body waits until the caller's stop handler is installed below; the caller opens it from
      // inside that handler's region, or the handler opens it after setting `stopped`.
      const handlerInstalled = Deferred.makeUnsafe<void>();
      yield* restore(Semaphore.take(permit, 1));
      const running = yield* Deferred.await(handlerInstalled).pipe(
        Effect.andThen(body(Effect.sync(() => stopped))),
        Effect.tapCause((cause) =>
          Cause.hasDies(cause)
            ? // The fixed job name only: a defect's text could carry anything.
              Effect.logError("A server-owned job ended with a defect.", { job })
            : Effect.void,
        ),
        Effect.ensuring(Semaphore.release(permit, 1)),
        Effect.forkIn(serviceScope),
      );
      return yield* restore(
        Deferred.succeed(handlerInstalled, undefined).pipe(Effect.andThen(Fiber.join(running))),
      ).pipe(
        // An interruption recorded while uninterruptible fires on entering `restore`, before the open.
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            stopped = true;
          }),
        ),
        Effect.ensuring(Deferred.succeed(handlerInstalled, undefined)),
      );
    }),
  );
});
