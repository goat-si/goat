import type { ProviderMaintenanceCapabilities } from "@goat/provider-core/server/maintenance";
import * as Cache from "effect/Cache";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Hash from "effect/Hash";

import { environmentCacheKey } from "./maintenanceEnvironmentCache.ts";

/** What one check resolved maintenance from: the environment it read and the executable it found. */
export interface ProviderMaintenanceLookup {
  readonly env: NodeJS.ProcessEnv;
  readonly resolvedCommandPath: string | null;
  /** More of the install's identity than its path, such as the file a link points to. */
  readonly install?: string | null;
}

// Equal by executable, install and an environment hash, so a registry, proxy or credential change
// with PATH unchanged starts a new lookup. The id holds no environment values.
class LookupKey implements Equal.Equal {
  readonly id: string;
  readonly lookup: ProviderMaintenanceLookup;
  constructor(lookup: ProviderMaintenanceLookup) {
    this.lookup = lookup;
    this.id = [
      lookup.resolvedCommandPath ?? "missing",
      lookup.install ?? "",
      environmentCacheKey(lookup.env),
    ].join("\0");
  }
  [Equal.symbol](that: unknown): boolean {
    return that instanceof LookupKey && that.id === this.id;
  }
  [Hash.symbol](): number {
    return Hash.string(this.id);
  }
}

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
  const unkeyed = new LookupKey({ env: {}, resolvedCommandPath: null });
  const cache = yield* Cache.make({
    capacity: 1,
    timeToLive: Duration.hours(1),
    lookup: (key: LookupKey) => (keyed ? keyed.resolve(key.lookup) : resolve),
  });
  return (options?: { readonly fresh?: boolean }) =>
    (keyed
      ? Effect.map(keyed.lookup, (lookup) => new LookupKey(lookup))
      : Effect.succeed(unkeyed)
    ).pipe(
      Effect.flatMap((key) => {
        const cached = Cache.get(cache, key);
        return options?.fresh ? Cache.invalidate(cache, key).pipe(Effect.andThen(cached)) : cached;
      }),
    );
});
