import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Fiber from "effect/Fiber";
import type * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";

export class ServerActivation extends Context.Reference<Effect.Effect<void> | undefined>(
  "goat/serverActivation",
  { defaultValue: () => undefined },
) {}

export class ServerCommandReady extends Context.Reference<Effect.Effect<void>>(
  "goat/serverCommandReady",
  { defaultValue: () => Effect.void },
) {}

export class SignalServerCommandReady extends Context.Reference<Effect.Effect<void>>(
  "goat/signalServerCommandReady",
  { defaultValue: () => Effect.void },
) {}

export const makeServerActivationLayer = Effect.fn("serverActivation.makeLayer")(function* (
  activation: Effect.Effect<void>,
) {
  const ready = yield* Deferred.make<void>();
  return Layer.mergeAll(
    Layer.succeed(ServerActivation, activation),
    Layer.succeed(ServerCommandReady, Deferred.await(ready)),
    Layer.succeed(SignalServerCommandReady, Deferred.succeed(ready, undefined).pipe(Effect.asVoid)),
  );
});

// Background work outlives its caller's span; parenting to it puts every run in one endless trace.
export const withoutParentSpan = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    // ParentSpan is optional to every reader, so removing it leaves R satisfied.
    Effect.updateContext(
      (context: Context.Context<R>) =>
        Context.omit(Tracer.ParentSpan)(context) as Context.Context<R>,
    ),
  );

export const forkParkedFiber = Effect.fnUntraced(function* <A, E, R>(
  input: Effect.Effect<A, E, R>,
): Effect.fn.Return<Fiber.Fiber<A, E>, never, Scope.Scope | R> {
  const effect = withoutParentSpan(input);
  const activation = yield* ServerActivation;
  if (activation === undefined) {
    return yield* Effect.forkScoped(effect);
  }
  const parked = yield* Deferred.make<void>();
  const fiber = yield* Effect.forkScoped(
    Deferred.succeed(parked, undefined).pipe(Effect.andThen(activation), Effect.andThen(effect)),
  );
  yield* Deferred.await(parked);
  return fiber;
});

export const forkParked = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<void, never, Scope.Scope | R> => forkParkedFiber(effect).pipe(Effect.asVoid);
