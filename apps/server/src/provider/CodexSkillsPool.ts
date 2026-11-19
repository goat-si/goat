import * as Effect from "effect/Effect";
import * as RcMap from "effect/RcMap";

export const makeCodexSkillsPool = Effect.fn("CodexSkillsPool.make")(function* <A, E, R>(
  open: (identity: string) => Effect.Effect<A, E, R>,
) {
  const helpers = yield* RcMap.make({ lookup: open, idleTimeToLive: "30 seconds", capacity: 8 });
  return <B, E2, R2>(identity: string, use: (helper: A) => Effect.Effect<B, E2, R2>) =>
    Effect.gen(function* () {
      const stale = [...(yield* RcMap.keys(helpers))].filter((key) => key !== identity);
      yield* Effect.forEach(stale, (key) => RcMap.invalidate(helpers, key), { discard: true });
      return yield* RcMap.get(helpers, identity).pipe(
        Effect.flatMap(use),
        Effect.scoped,
        Effect.onError(() => RcMap.invalidate(helpers, identity)),
        Effect.retry({ times: 1 }),
      );
    });
});
