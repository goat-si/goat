import type { ServerLifecycleStreamEvent } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

type LifecycleEventInput =
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "runtimeDrain" }>, "sequence">
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "welcome" }>, "sequence">
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "ready" }>, "sequence">
  | Omit<Extract<ServerLifecycleStreamEvent, { type: "legacyThreadMigration" }>, "sequence">;

interface SnapshotState {
  readonly sequence: number;
  readonly events: ReadonlyArray<ServerLifecycleStreamEvent>;
}

export class ServerLifecycleEvents extends Context.Service<
  ServerLifecycleEvents,
  {
    readonly publish: (event: LifecycleEventInput) => Effect.Effect<ServerLifecycleStreamEvent>;
    readonly snapshot: Effect.Effect<SnapshotState>;
    readonly stream: Stream.Stream<ServerLifecycleStreamEvent>;
  }
>()("goat/serverLifecycleEvents") {}

const make = Effect.gen(function* () {
  const pubsub = yield* PubSub.sliding<void>(1);
  const state = yield* Ref.make<SnapshotState>({
    sequence: 0,
    events: [],
  });

  return {
    publish: (event) =>
      Ref.modify(state, (current) => {
        const nextSequence = current.sequence + 1;
        const nextEvent = {
          ...event,
          sequence: nextSequence,
        } satisfies ServerLifecycleStreamEvent;
        const nextEvents = [
          nextEvent,
          ...current.events.filter((entry) => entry.type !== nextEvent.type),
        ];
        return [nextEvent, { sequence: nextSequence, events: nextEvents }] as const;
      }).pipe(Effect.tap(() => PubSub.publish(pubsub, undefined))),
    snapshot: Ref.get(state),
    get stream() {
      return Stream.unwrap(
        Effect.gen(function* () {
          const subscription = yield* PubSub.subscribe(pubsub);
          let afterSequence = 0;
          const sample = Ref.get(state).pipe(
            Effect.map((current) => {
              const events = current.events
                .filter((event) => event.sequence > afterSequence)
                .toSorted((left, right) => left.sequence - right.sequence);
              afterSequence = current.sequence;
              return events;
            }),
          );
          return Stream.concat(
            Stream.fromEffect(sample),
            Stream.fromSubscription(subscription).pipe(Stream.mapEffect(() => sample)),
          ).pipe(Stream.flatMap((events) => Stream.fromIterable(events)));
        }),
      );
    },
  } satisfies ServerLifecycleEvents["Service"];
});

export const layer = Layer.effect(ServerLifecycleEvents, make);
