import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type * as ProviderAdapter from "@goat/provider-core/server/ProviderAdapter";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

export const CaptureEventQueue = Context.Reference<
  ((offer: (marker: object) => Effect.Effect<boolean>) => Effect.Effect<void>) | undefined
>("ClaudeAdapterV2.test/CaptureEventQueue", { defaultValue: () => undefined });

export const makeWakeObservations = Effect.gen(function* () {
  const changes = yield* PubSub.unbounded<void>();
  const eventQueue = yield* Deferred.make<(marker: object) => Effect.Effect<boolean>>();
  const markers = new WeakMap<object, Deferred.Deferred<void>>();
  const collectEvents = <E, R>(
    stream: Stream.Stream<ProviderAdapter.ProviderAdapterV2Event, E, R>,
    record: (event: ProviderAdapter.ProviderAdapterV2Event) => Effect.Effect<void>,
  ) =>
    stream.pipe(
      Stream.runForEach((event) => {
        const marker = markers.get(event);
        return marker === undefined ? record(event) : Deferred.succeed(marker, undefined);
      }),
      Effect.provideService(CaptureEventQueue, (offer) =>
        Deferred.succeed(eventQueue, offer).pipe(Effect.asVoid),
      ),
    );
  const awaitEventsRecorded = Effect.gen(function* () {
    const offer = yield* Deferred.await(eventQueue);
    const marker = {};
    const recorded = yield* Deferred.make<void>();
    markers.set(marker, recorded);
    if (!(yield* offer(marker))) return yield* Effect.die("Event queue rejected barrier.");
    yield* Deferred.await(recorded);
  });
  const processedMessages = new WeakMap<SDKMessage, Deferred.Deferred<void>>();
  const consumers = new WeakMap<
    Queue.Queue<SDKMessage>,
    Deferred.Deferred<Fiber.Fiber<unknown, unknown>>
  >();
  const observe = (update: () => void) =>
    Effect.sync(update).pipe(Effect.andThen(PubSub.publish(changes, undefined)), Effect.asVoid);
  const awaitUntil = (predicate: () => boolean, label: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        // Subscribe before checking: an update cannot be lost between the
        // predicate and suspension, including while transcript I/O is pending.
        const subscription = yield* PubSub.subscribe(changes);
        while (!predicate()) yield* PubSub.take(subscription);
        yield* awaitEventsRecorded;
      }),
    ).pipe(Effect.onInterrupt(() => Effect.logError(`Interrupted waiting for ${label}.`)));
  const messages = (queue: Queue.Queue<SDKMessage>) => {
    const consumer = Deferred.makeUnsafe<Fiber.Fiber<unknown, unknown>>();
    consumers.set(queue, consumer);
    return Stream.unwrap(
      Effect.withFiber((fiber) =>
        Deferred.succeed(consumer, fiber).pipe(
          Effect.as(
            Stream.fromQueue(queue).pipe(
              Stream.flatMap((message) =>
                Stream.make(message).pipe(
                  // The next pull follows the adapter's handling of this frame.
                  Stream.concat(
                    Stream.fromEffect(
                      Effect.suspend(() => {
                        const processed = processedMessages.get(message);
                        return processed === undefined
                          ? Effect.void
                          : Deferred.succeed(processed, undefined);
                      }),
                    ).pipe(Stream.drain),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
  };
  const offerAndWait = Effect.fnUntraced(function* (
    queue: Queue.Queue<SDKMessage>,
    message: SDKMessage,
    offered?: Deferred.Deferred<void>,
  ) {
    const processed = yield* Deferred.make<void>();
    processedMessages.set(message, processed);
    yield* Queue.offer(queue, message);
    if (offered !== undefined) yield* Deferred.succeed(offered, undefined);
    yield* Deferred.await(processed);
    yield* awaitEventsRecorded;
  });
  const awaitQueryExit = Effect.fnUntraced(function* (queue: Queue.Queue<SDKMessage>) {
    const consumer = consumers.get(queue);
    if (consumer === undefined) return yield* Effect.die("No query consumer for this queue.");
    // Join the adapter's consuming fiber, including its query-exit cleanup.
    yield* Fiber.await(yield* Deferred.await(consumer));
    yield* awaitEventsRecorded;
  });
  return {
    observe,
    collectEvents,
    awaitEventsRecorded,
    awaitUntil,
    messages,
    offerAndWait,
    awaitQueryExit,
  };
});
