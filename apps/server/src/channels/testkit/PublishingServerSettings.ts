import type { ServerSettings as Settings } from "@goat/contracts";
import type { DeepPartial } from "@goat/shared/Struct";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";

import * as ServerSettings from "../../serverSettings.ts";

/** The real test settings merge, with a subscription that observes committed changes. */
export const layer = (overrides: DeepPartial<Settings> = {}) =>
  Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const changes = yield* PubSub.unbounded<Settings>();
      const publish = (next: Settings) => PubSub.publish(changes, next);
      return ServerSettings.ServerSettingsService.of({
        ...settings,
        updateSettings: (patch, authorizeAtCommit) =>
          settings.updateSettings(patch, authorizeAtCommit).pipe(Effect.tap(publish)),
        updateProviderInstance: (mutation, patch) =>
          settings.updateProviderInstance(mutation, patch).pipe(Effect.tap(publish)),
        streamChanges: Stream.fromPubSub(changes),
        subscribeChanges: PubSub.subscribe(changes).pipe(Effect.map(Stream.fromSubscription)),
      });
    }),
  ).pipe(Layer.provide(ServerSettings.layerTest(overrides)), Layer.orDie);
