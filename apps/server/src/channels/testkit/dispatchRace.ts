import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import * as ChannelLedger from "../ChannelLedger.ts";
import { PlacementStarted } from "../channelDispatchFences.ts";

type HeldMethod = "findIdentity" | "getRemoteWorker";

/** Parks the ledger's next call to `method` until released, so a test acts while a reader waits. */
export const holdNextLedgerCall = Effect.fn("test.holdNextLedgerCall")(function* (
  method: HeldMethod,
) {
  const ledger = yield* ChannelLedger.ChannelLedger;
  const reached = yield* Deferred.make<void>();
  const released = yield* Deferred.make<void>();
  const observed: Record<
    HeldMethod,
    (input: never) => Effect.Effect<unknown, ChannelLedger.ChannelLedgerError>
  > = ledger;
  const original = observed[method];
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      observed[method] = (input) => {
        observed[method] = original;
        return Deferred.succeed(reached, undefined).pipe(
          Effect.andThen(Deferred.await(released)),
          Effect.andThen(original(input)),
        );
      };
    }),
    () =>
      Effect.sync(() => {
        observed[method] = original;
      }),
  );
  return { reached: Deferred.await(reached), release: Deferred.succeed(released, undefined) };
});

/** Records the automatic placements a dispatch starts, so a test awaits their end, never polls. */
export const trackPlacements = () => {
  const started = new Set<Fiber.Fiber<unknown, unknown>>();
  return {
    observe: <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provideService(PlacementStarted, (fiber) =>
          Effect.sync(() => {
            started.add(fiber);
          }),
        ),
      ),
    /** The placements started since the last wait have ended; a wait that saw none is wrong. */
    settled: Effect.suspend(() => {
      const fibers = [...started];
      started.clear();
      return fibers.length === 0
        ? Effect.die("no automatic placement started since the last wait")
        : Effect.forEach(fibers, (fiber) => Fiber.await(fiber), { discard: true });
    }),
  };
};
