import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

export const BackgroundGitWork = Context.Reference<boolean>("goat/vcs/BackgroundGitWork", {
  defaultValue: () => false,
});

export const TargetedSettlementGitWork = Context.Reference<boolean>(
  "goat/vcs/TargetedSettlementGitWork",
  { defaultValue: () => false },
);

const foreground = Semaphore.makeUnsafe(8);
const background = Semaphore.makeUnsafe(2);
const targetedSettlement = Semaphore.makeUnsafe(2);

// Git execution already has an operation span.
export const withGitPermit = Effect.fnUntraced(function* <A, E, R>(
  execution: Effect.Effect<A, E, R>,
) {
  const lane = (yield* TargetedSettlementGitWork)
    ? targetedSettlement
    : (yield* BackgroundGitWork)
      ? background
      : foreground;
  return yield* lane.withPermits(1)(execution);
});
