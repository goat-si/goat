import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import type * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

export type ProviderSessionEventSignal =
  | { readonly type: "event"; readonly event: ProviderAdapter.ProviderAdapterV2Event }
  | {
      readonly type: "failure";
      readonly cause: Cause.Cause<ProviderAdapter.ProviderAdapterV2Error>;
    };

export const makeProviderSessionEventSubscription = Effect.fn(
  "ProviderSessionManager.makeEventSubscription",
)(function* (
  subscribers: Ref.Ref<ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>>,
  nextSubscriberId: Ref.Ref<number>,
  subscriberReleaseCleanup: WeakMap<
    Queue.Queue<ProviderSessionEventSignal, Cause.Done>,
    Effect.Effect<void>
  >,
): Effect.fn.Return<ProviderAdapter.ProviderAdapterV2EventSubscription> {
  const queue = yield* Queue.unbounded<ProviderSessionEventSignal, Cause.Done>();
  const subscriberId = yield* Ref.getAndUpdate(nextSubscriberId, (value) => value + 1);
  yield* Ref.update(subscribers, (current) => {
    const updated = new Map(current);
    updated.set(subscriberId, queue);
    return updated;
  });
  const close = (awaitSettlement: boolean) =>
    Ref.modify(subscribers, (current) => {
      if (!current.has(subscriberId)) {
        return [false, current] as const;
      }
      const updated = new Map(current);
      updated.delete(subscriberId);
      return [true, updated] as const;
    }).pipe(
      Effect.flatMap((removed) =>
        removed
          ? Queue.clear(queue).pipe(Effect.andThen(Queue.end(queue)), Effect.asVoid)
          : Effect.void,
      ),
      Effect.andThen(
        Effect.suspend(() => {
          const cleanup = subscriberReleaseCleanup.get(queue);
          subscriberReleaseCleanup.delete(queue);
          if (cleanup === undefined) return Effect.void;
          return Effect.flatMap(Effect.forkDetach(cleanup), (settlement) =>
            awaitSettlement ? Effect.interruptible(Fiber.join(settlement)) : Effect.void,
          );
        }),
      ),
    );
  const events = Stream.fromQueue(queue).pipe(
    Stream.mapEffect((signal) =>
      signal.type === "event" ? Effect.succeed(signal.event) : Effect.failCause(signal.cause),
    ),
    // A drained subscription completes after the release revisit settles its late writes.
    Stream.onExit((exit) => close(!Exit.hasInterrupts(exit))),
  );
  return {
    events,
    close: close(false),
  } satisfies ProviderAdapter.ProviderAdapterV2EventSubscription;
});
