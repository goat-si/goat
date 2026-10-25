import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

/** A foreground grant can end before background admission, including while the stream stalls. */
export const watchLeaseProxyDeadlines = Effect.fn("ComputerUseLeaseProxy.watchDeadlines")(
  function* <E>(input: {
    readonly wake: Queue.Queue<void>;
    readonly controlDeadline: () => number;
    readonly foregroundDeadline: () => number;
    readonly expireControl: Effect.Effect<void>;
    readonly expireForeground: (now: number) => Effect.Effect<void, E>;
  }) {
    for (;;) {
      const now = yield* Clock.currentTimeMillis;
      if (now >= input.controlDeadline()) return yield* input.expireControl;
      if (now >= input.foregroundDeadline()) {
        yield* input.expireForeground(now);
        continue;
      }
      const next = Math.min(input.controlDeadline(), input.foregroundDeadline());
      yield* Effect.raceFirst(Queue.take(input.wake), Effect.sleep(next - now));
    }
  },
);
