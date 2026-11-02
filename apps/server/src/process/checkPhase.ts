import * as Effect from "effect/Effect";

export const liveInCheckPhase = <A>(block: () => A) =>
  Effect.callback<A>((resume) => {
    const id = setImmediate(() => resume(Effect.succeed(block())));
    return Effect.sync(() => clearImmediate(id));
  });
