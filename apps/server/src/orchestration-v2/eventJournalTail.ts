import type { EventStoreV2, EventStoreV2Error } from "./EventStore.ts";
import type {
  OrchestrationV2StoredEvent,
  OrchestrationV2DomainEvent,
  ThreadId,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

export const makeEventJournalTail = Effect.gen(function* () {
  const committed = yield* PubSub.sliding<number>(1);
  let published = 0;
  return {
    publish: (events: ReadonlyArray<OrchestrationV2StoredEvent>) =>
      Effect.suspend(() => {
        const last = events.at(-1);
        if (last === undefined || last.sequence <= published) return Effect.void;
        published = last.sequence;
        return PubSub.publish(committed, published);
      }),
    stream: <E>(input: {
      readonly afterSequence: number;
      readonly latestSequence: Effect.Effect<number, E>;
      readonly onSubscribed: Effect.Effect<void> | undefined;
      readonly replay: (
        afterSequence: number,
        throughSequence: number,
      ) => Stream.Stream<OrchestrationV2StoredEvent, EventStoreV2Error>;
    }) =>
      Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(committed);
          const highWater = yield* input.latestSequence;
          if (input.onSubscribed !== undefined) yield* input.onSubscribed;
          let cursor = input.afterSequence;
          return Stream.concat(
            Stream.succeed(highWater),
            Stream.fromSubscription(subscription),
          ).pipe(
            Stream.flatMap((through) => {
              if (through <= cursor) return Stream.empty;
              const after = cursor;
              cursor = through;
              return input.replay(after, through);
            }),
          );
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
