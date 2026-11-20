import type { SpeechConfiguration } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

export const make = Effect.gen(function* () {
  const changes = yield* PubSub.sliding<SpeechConfiguration & { readonly revision: number }>(1);
  let previous: SpeechConfiguration | undefined;
  let revision = 0;
  return {
    publish: Effect.fn("SpeechSettingsChanges.publish")(function* (
      configuration: SpeechConfiguration,
    ) {
      if (
        previous?.modelId !== configuration.modelId ||
        previous.acceleration !== configuration.acceleration
      ) {
        previous = configuration;
        revision++;
      }
      yield* PubSub.publish(changes, { ...configuration, revision });
    }),
    revision: Effect.sync(() => revision),
    subscribe: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
  };
});
