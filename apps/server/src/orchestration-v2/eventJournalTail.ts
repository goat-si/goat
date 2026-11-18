import type { EventStoreV2, EventStoreV2Error } from "./EventStore.ts";
import type {
  OrchestrationV2StoredEvent,
  OrchestrationV2DomainEvent,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

export const makeEventJournalTail = Effect.sync(() => {
  type EventType = OrchestrationV2DomainEvent["type"];
  const makeFeed = (eventTypes: ReadonlyArray<EventType> | undefined) =>
    PubSub.sliding<number>(1).pipe(
      Effect.map((signals) => ({
        matches: eventTypes === undefined ? undefined : new Set(eventTypes),
        signals,
        published: 0,
      })),
    );
  const feeds = new Map<string, Effect.Success<ReturnType<typeof makeFeed>>>();
  return {
    // One call per commit, under the event sink's tracing boundary.
    publish: Effect.fnUntraced(function* (events: ReadonlyArray<OrchestrationV2StoredEvent>) {
      for (const feed of feeds.values()) {
        const last =
          feed.matches === undefined
            ? events.at(-1)
            : events.findLast(({ event }) => feed.matches?.has(event.type));
        if (last === undefined || last.sequence <= feed.published) continue;
        feed.published = last.sequence;
        yield* PubSub.publish(feed.signals, feed.published);
      }
    }),
    stream: <E>(input: {
      readonly afterSequence: number;
      readonly eventTypes: ReadonlyArray<EventType> | undefined;
      readonly latestSequence: Effect.Effect<number, E>;
      readonly onSubscribed: Effect.Effect<void> | undefined;
      readonly replay: (
        afterSequence: number,
        throughSequence: number,
      ) => Stream.Stream<OrchestrationV2StoredEvent, EventStoreV2Error>;
    }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const key = input.eventTypes?.toSorted().join(",") ?? "*";
          let feed = feeds.get(key);
          if (feed === undefined) {
            const candidate = yield* makeFeed(input.eventTypes);
            feed = feeds.get(key) ?? candidate;
            feeds.set(key, feed);
          }
          const subscription = yield* PubSub.subscribe(feed.signals);
          const highWater = yield* input.latestSequence;
          if (input.onSubscribed !== undefined) yield* input.onSubscribed;
          let cursor = Math.max(input.afterSequence, highWater);
          const live = Stream.fromSubscription(subscription).pipe(
            Stream.flatMap((through) => {
              if (through <= cursor) return Stream.empty;
              const after = cursor;
              cursor = through;
              return input.replay(after, through);
            }),
          );
          return Stream.concat(input.replay(input.afterSequence, highWater), live);
        }),
      ),
  };
});

export const makeEventJournalCatchUp =
  (eventStore: Pick<EventStoreV2["Service"], "read">) =>
  (input: {
    readonly afterSequence: number;
    readonly throughSequence: number;
    readonly threadId?: ThreadId;
    readonly eventType?: OrchestrationV2DomainEvent["type"];
    readonly eventTypes?: ReadonlyArray<OrchestrationV2DomainEvent["type"]>;
  }): Stream.Stream<OrchestrationV2StoredEvent, EventStoreV2Error> => {
    const pageSize = 256;
    const loop = (
      afterSequence: number,
    ): Stream.Stream<OrchestrationV2StoredEvent, EventStoreV2Error> =>
      Stream.unwrap(
        eventStore
          .read({
            afterSequence,
            throughSequence: input.throughSequence,
            ...(input.threadId === undefined ? {} : { threadId: input.threadId }),
            ...(input.eventType === undefined ? {} : { eventType: input.eventType }),
            ...(input.eventTypes === undefined ? {} : { eventTypes: input.eventTypes }),
            limit: pageSize,
          })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
            Effect.map((events) => {
              if (events.length === 0) {
                return Stream.empty;
              }
              const current = Stream.fromIterable(events);
              const last = events.at(-1)?.sequence ?? input.throughSequence;
              return events.length < pageSize || last >= input.throughSequence
                ? current
                : Stream.concat(current, loop(last));
            }),
          ),
      );
    return loop(input.afterSequence);
  };
