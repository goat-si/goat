import * as Effect from "effect/Effect";
import type * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

/**
 * Effect.forkIn as Effect 4.0 ran it. Effect 4.1 forks nothing into a closed scope and returns a
 * fiber interrupted unrun, so the work's own cleanup never runs. Here it starts detached and is
 * interrupted at once: its finalizers run, and uninterruptible work finishes.
 */
export const forkInScope =
  (
    scope: Scope.Scope,
    options?: {
      readonly startImmediately?: boolean | undefined;
      readonly uninterruptible?: boolean | "inherit" | undefined;
    },
  ) =>
  <A, E, R>(self: Effect.Effect<A, E, R>): Effect.Effect<Fiber.Fiber<A, E>, never, R> =>
    Effect.suspend(() =>
      scope.state._tag === "Closed"
        ? Effect.forkDetach(self, options).pipe(
            Effect.tap((fiber) => Effect.sync(() => fiber.interruptUnsafe())),
          )
        : Effect.forkIn(self, scope, options),
    );
