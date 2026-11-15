import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

/**
 * The operation a test observes. Forked fibers inherit it, so work the driver started before that
 * operation, such as the check forked on creation, never carries it.
 */
export const ObservedOperation = Context.Reference<string | undefined>(
  "test/CodexDriver/ObservedOperation",
  { defaultValue: () => undefined },
);

export const observing =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, ObservedOperation, operation);

/** The running fiber's observed operation, for synchronous hooks such as a Proxy trap. */
export const currentObservedOperation = (): string | undefined =>
  Fiber.getCurrent()?.getRef(ObservedOperation);
