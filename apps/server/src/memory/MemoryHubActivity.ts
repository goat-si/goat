import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

/** Commit notifications include semantic refusals that do not change a memory item. */
export class MemoryHubActivity extends Context.Service<
  MemoryHubActivity,
  {
    readonly notify: Effect.Effect<void>;
    readonly subscribe: Effect.Effect<Stream.Stream<void>, never, Scope.Scope>;
  }
>()("goat/memory/MemoryHubService/MemoryHubActivity") {}

export const activityLayer = Layer.effect(
  MemoryHubActivity,
  Effect.gen(function* () {
    const events = yield* PubSub.dropping<void>(1);
    return MemoryHubActivity.of({
      notify: Effect.asVoid(PubSub.publish(events, undefined)),
      subscribe: Effect.map(PubSub.subscribe(events), Stream.fromSubscription),
    });
  }),
);
