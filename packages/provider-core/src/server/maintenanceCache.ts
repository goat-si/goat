import type { ProviderMaintenanceCapabilities } from "@goat/provider-core/server/maintenance";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

export const makeCachedProviderMaintenanceResolution = Effect.fn(
  "makeCachedProviderMaintenanceResolution",
)(function* (
  resolve: Effect.Effect<ProviderMaintenanceCapabilities>,
  keyed?: {
    readonly key: Effect.Effect<string>;
    readonly resolve: (key: string) => Effect.Effect<ProviderMaintenanceCapabilities>;
  },
) {
  const cache = yield* Cache.make({
    capacity: 1,
    timeToLive: Duration.hours(1),
    lookup: (key: string) => (keyed ? keyed.resolve(key) : resolve),
  });
  return (options?: { readonly fresh?: boolean }) =>
    (keyed?.key ?? Effect.succeed("")).pipe(
      Effect.flatMap((key) => {
        const cached = Cache.get(cache, key);
        return options?.fresh ? Cache.invalidate(cache, key).pipe(Effect.andThen(cached)) : cached;
      }),
    );
});
