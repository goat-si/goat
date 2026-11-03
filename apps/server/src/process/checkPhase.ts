import * as Effect from "effect/Effect";

export const liveInCheckPhase = <A>(block: () => A) =>
  Effect.callback<A>((resume) => {
    const id = setImmediate(() => {
      try {
        resume(Effect.succeed(block()));
      } catch (error) {
        resume(Effect.die(error));
      }
    });
    return Effect.sync(() => clearImmediate(id));
  });
