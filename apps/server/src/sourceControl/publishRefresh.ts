import * as Effect from "effect/Effect";

export function publishWithRefresh<A, E>(
  publish: Effect.Effect<A, E>,
  identity: Effect.Effect<unknown>,
  status: Effect.Effect<unknown>,
): Effect.Effect<A, E> {
  return publish.pipe(Effect.ensuring(identity.pipe(Effect.andThen(status))));
}
