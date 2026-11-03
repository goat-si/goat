import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";

export interface QuietState {
  readonly lastActivity: number;
  readonly lastTick: bigint;
  readonly quiet: bigint;
}

export const advanceQuiet = (
  state: QuietState,
  now: bigint,
  activity: number,
  interval: bigint,
): QuietState => {
  const elapsed = now > state.lastTick ? now - state.lastTick : 0n;
  return {
    lastActivity: activity,
    lastTick: now,
    quiet:
      activity !== state.lastActivity
        ? 0n
        : state.quiet + (elapsed < interval ? elapsed : interval),
  };
};

export const awaitQuiet = Effect.fn("StallAwareQuiet.awaitQuiet")(function* (options: {
  readonly windowMs: number;
  readonly activity: () => number;
  readonly drainIo: Effect.Effect<void>;
}) {
  const clock = yield* Clock.Clock;
  const intervalMs = Math.min(5_000, options.windowMs);
  const interval = BigInt(intervalMs) * 1_000_000n;
  const window = BigInt(options.windowMs) * 1_000_000n;
  let state: QuietState = {
    lastActivity: options.activity(),
    lastTick: clock.monotonicTimeNanosUnsafe(),
    quiet: 0n,
  };
  while (state.quiet < window) {
    yield* Effect.sleep(intervalMs);
    yield* options.drainIo;
    state = advanceQuiet(state, clock.monotonicTimeNanosUnsafe(), options.activity(), interval);
  }
});
