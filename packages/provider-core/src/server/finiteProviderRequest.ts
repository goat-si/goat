import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

export const makeFiniteRequestGuard = Effect.fn("FiniteProviderRequest.make")(function* <
  E,
>(policy: {
  readonly duration: (method: string) => Duration.Input | undefined;
  readonly error: (method: string) => E;
}) {
  const retired = yield* Deferred.make<E>();
  const terminated = Deferred.await(retired);
  const request = Effect.fn("FiniteProviderRequest.request")(function* <A, E2, R>(
    method: string,
    effect: Effect.Effect<A, E2, R>,
  ) {
    if (yield* Deferred.isDone(retired)) return yield* Effect.fail(yield* terminated);
    const duration = policy.duration(method);
    const bounded =
      duration === undefined
        ? effect
        : effect.pipe(
            Effect.timeoutOrElse({
              duration,
              orElse: () => {
                const error = policy.error(method);
                return Deferred.succeed(retired, error).pipe(Effect.andThen(Effect.fail(error)));
              },
            }),
          );
    return yield* Effect.raceFirst(bounded, terminated.pipe(Effect.flatMap(Effect.fail)));
  });
  return { request, terminated };
});
