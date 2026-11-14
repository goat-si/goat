import type { ProviderMaintenanceCapabilities } from "@goat/provider-core/server/maintenance";
import * as Cache from "effect/Cache";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

import { environmentCacheKey } from "./maintenanceEnvironmentCache.ts";

/** What one check resolved maintenance from: the environment it read and the executable it found. */
export interface ProviderMaintenanceLookup {
  readonly env: NodeJS.ProcessEnv;
  readonly resolvedCommandPath: string | null;
  /** More of the install's identity than its path, such as the file a link points to. */
  readonly install?: string | null;
}

// The lookup that missed reaches the resolver through the request, so the cached key holds only
// the executable, the install and an environment hash, never environment values.
const PendingLookup = Context.Reference<ProviderMaintenanceLookup | undefined>(
  "@goat/provider-core/maintenanceCache/PendingLookup",
  { defaultValue: () => undefined },
);

export const makeCachedProviderMaintenanceResolution = Effect.fn(
  "makeCachedProviderMaintenanceResolution",
)(function* (
  resolve: Effect.Effect<ProviderMaintenanceCapabilities>,
  keyed?: {
    readonly lookup: Effect.Effect<ProviderMaintenanceLookup>;
    readonly resolve: (
      lookup: ProviderMaintenanceLookup,
    ) => Effect.Effect<ProviderMaintenanceCapabilities>;
  },
) {
  const cache = yield* Cache.make({
    capacity: 1,
    timeToLive: Duration.hours(1),
    lookup: (_id: string) =>
      Effect.flatMap(PendingLookup, (lookup) =>
        keyed && lookup ? keyed.resolve(lookup) : resolve,
      ),
  });
  const request = (id: string, lookup: ProviderMaintenanceLookup | undefined, fresh: boolean) => {
    const cached = Cache.get(cache, id);
    return (fresh ? Cache.invalidate(cache, id).pipe(Effect.andThen(cached)) : cached).pipe(
      Effect.provideService(PendingLookup, lookup),
    );
  };
  return (options?: { readonly fresh?: boolean }) =>
    keyed
      ? Effect.flatMap(keyed.lookup, (found) => {
          // A copy, so the resolver reads exactly the environment that was hashed.
          const lookup = { ...found, env: { ...found.env } };
          const id = [
            lookup.resolvedCommandPath ?? "missing",
            lookup.install ?? "",
            environmentCacheKey(lookup.env),
          ].join("\0");
          return request(id, lookup, options?.fresh === true);
        })
      : request("", undefined, options?.fresh === true);
});
