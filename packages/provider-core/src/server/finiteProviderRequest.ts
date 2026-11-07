import * as Deferred from "effect/Deferred";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";

export const makeFiniteRequestGuard = Effect.fn("FiniteProviderRequest.make")(function* <
  E,
>(policy: {
  readonly duration: (method: string) => Duration.Input | undefined;
  readonly error: (method: string) => E;
  readonly liveness?: {
    readonly retiresAlone: (method: string) => boolean;
    readonly probe: Effect.Effect<void>;
    readonly window: Duration.Input;
    readonly scope: Scope.Scope;
  };
}) {
  const retired = yield* Deferred.make<E>();
  const terminated = Deferred.await(retired);
  let generation = 0;
  let listening: Deferred.Deferred<void> | undefined;
  let probing = false;
  let abandoned = 0;
  const heard = Effect.suspend(() => {
    generation++;
    return listening === undefined
      ? Effect.void
      : Deferred.succeed(listening, undefined).pipe(Effect.asVoid);
  });
  const request = Effect.fn("FiniteProviderRequest.request")(function* <A, E2, R>(
    method: string,
    effect: Effect.Effect<A, E2, R>,
    onLate?: (value: A) => Effect.Effect<void>,
  ) {
    if (yield* Deferred.isDone(retired)) return yield* Effect.fail(yield* terminated);
    const sentAt = generation;
    const duration = policy.duration(method);
    const liveness = policy.liveness;
    const fiber =
      liveness !== undefined && duration !== undefined
        ? yield* effect.pipe(Effect.forkIn(liveness.scope, { startImmediately: true }))
        : undefined;
    let retained = false;
    const waiting = fiber === undefined ? effect : Fiber.join(fiber);
    const bounded =
      duration === undefined
        ? waiting
        : waiting.pipe(
            Effect.timeoutOrElse({
              duration,
              orElse: Effect.fn("FiniteProviderRequest.deadline")(function* () {
                const error = policy.error(method);
                if (
                  fiber !== undefined &&
                  liveness !== undefined &&
                  // A late answer with a handler gets a larger share; its handler may stop work.
                  abandoned < (onLate === undefined ? 64 : 1024) &&
                  !liveness.retiresAlone(method)
                ) {
                  yield* Effect.uninterruptible(
                    Effect.suspend(() => {
                      retained = true;
                      abandoned++;
                      return Fiber.join(fiber).pipe(
                        Effect.flatMap((value) => onLate?.(value) ?? Effect.void),
                        Effect.catchCause((cause) =>
                          Effect.logWarning("finite-provider-request.late-failed", { cause }),
                        ),
                        Effect.ensuring(
                          Effect.sync(() => {
                            abandoned--;
                          }),
                        ),
                        Effect.forkIn(liveness.scope),
                      );
                    }),
                  );
                } else if (fiber !== undefined) {
                  yield* Fiber.interrupt(fiber);
                }
                if (liveness === undefined || liveness.retiresAlone(method)) {
                  yield* Deferred.succeed(retired, error);
                } else if (generation === sentAt && !probing) {
                  probing = true;
                  const signal = yield* Deferred.make<void>();
                  listening = signal;
                  yield* Effect.raceFirst(liveness.probe, Deferred.await(signal)).pipe(
                    Effect.timeoutOrElse({
                      duration: liveness.window,
                      orElse: () => Deferred.succeed(retired, error).pipe(Effect.asVoid),
                    }),
                    Effect.ensuring(
                      Effect.sync(() => {
                        listening = undefined;
                        probing = false;
                      }),
                    ),
                    Effect.forkIn(liveness.scope),
                  );
                }
                return yield* Effect.fail(error);
              }),
            }),
          );
    return yield* Effect.raceFirst(bounded, terminated.pipe(Effect.flatMap(Effect.fail))).pipe(
      Effect.onInterrupt(() =>
        fiber !== undefined && !retained ? Fiber.interrupt(fiber).pipe(Effect.asVoid) : Effect.void,
      ),
      Effect.onError(() =>
        fiber !== undefined && !retained ? Fiber.interrupt(fiber).pipe(Effect.asVoid) : Effect.void,
      ),
    );
  });
  return { request, terminated, heard };
});
