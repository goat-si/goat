import type {
  ProviderContinuationOffer,
  ProviderContinuationRequest,
} from "@goat/provider-core/server/ProviderContinuationRequests";
import * as Effect from "effect/Effect";
import * as FiberMap from "effect/FiberMap";
import type * as Semaphore from "effect/Semaphore";

export const makeWakeOffers = Effect.fn("Muse.makeWakeOffers")(function* (
  requests: ProviderContinuationOffer | undefined,
  eventPermit: Semaphore.Semaphore,
) {
  const attempts = yield* FiberMap.make<"wake">();
  const offer = Effect.fn("Muse.offerWake")(function* (
    request: ProviderContinuationRequest,
    isCurrent: () => boolean,
  ) {
    if (requests === undefined || (yield* requests.offer(request)) !== "overflow") return;
    const awaitSpace = requests.awaitSpace;
    if (awaitSpace === undefined)
      return yield* Effect.die("Muse wake overflow requires a capacity signal");
    yield* Effect.gen(function* () {
      do {
        yield* awaitSpace(request.threadId);
      } while (
        (yield* eventPermit.withPermit(
          Effect.suspend((): Effect.Effect<void | "overflow"> =>
            isCurrent() ? requests.offer(request) : Effect.void,
          ),
        )) === "overflow"
      );
    }).pipe(Effect.interruptible, FiberMap.run(attempts, "wake"));
  });
  return { offer, cancel: FiberMap.clear(attempts) };
});
