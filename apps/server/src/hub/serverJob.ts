import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";

/**
 * Runs `body` as a server-owned job once the caller holds `permit`, so a caller gone before its
 * turn leaves no job and one permit means one job at a time. The started body runs to its end;
 * `stopped` says its caller stopped waiting, so it finishes what is under way and starts nothing new.
 */
export const runAsServerJob = <A, E, R>(
  permit: Semaphore.Semaphore,
  serviceScope: Scope.Scope,
  job: string,
  body: (stopped: Effect.Effect<boolean>) => Effect.Effect<A, E, R>,
): Effect.Effect<A, E, R> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      let stopped = false;
      yield* restore(Semaphore.take(permit, 1));
      const running = yield* body(Effect.sync(() => stopped)).pipe(
        Effect.tapCause((cause) =>
          Cause.hasDies(cause)
            ? Effect.logError("A server-owned job ended with a defect.", {
                job,
                cause: Cause.pretty(cause),
              })
            : Effect.void,
        ),
        Effect.ensuring(Semaphore.release(permit, 1)),
        Effect.forkIn(serviceScope),
      );
      return yield* restore(Fiber.join(running)).pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            stopped = true;
          }),
        ),
      );
    }),
  );
