import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { ForwardStarted } from "../ChannelRemoteWorkers.ts";

/** Records the answer forwards a test starts, so it awaits their attempts instead of polling. */
export const trackForwards = () => {
  const started = new Set<Fiber.Fiber<void>>();
  return {
    observe: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(ForwardStarted, (fiber) =>
          Effect.sync(() => {
            started.add(fiber);
          }),
        ),
      ),
    /** The forwards started since the last wait have ended; a wait that saw none is wrong. */
    settled: Effect.suspend(() => {
      const fibers = [...started];
      started.clear();
      return fibers.length === 0
        ? Effect.die("no answer forward started since the last wait")
        : Effect.forEach(fibers, (fiber) => Fiber.await(fiber), { discard: true });
    }),
  };
};
