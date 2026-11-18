import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ConnectionCatalogEntry, ConnectionProfile, ConnectionRoute } from "./catalog.ts";
import type { ConnectionTarget } from "./model.ts";
import type * as ConnectionProfileStore from "./profileStore.ts";
import { pullRequestRoutingConnectionKey } from "./pullRequestRoutingPermissions.ts";
import { entryWithRoutes, routeIsShown } from "./routes.ts";

/** An environment left with only Pen routes the closed gate hides stays saved, off the list. */
export function targetsOfShownEnvironments<T extends ConnectionTarget>(
  targets: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const shown = new Set(
    targets.filter((target) => routeIsShown({ target })).map((target) => target.environmentId),
  );
  return targets.filter((target) => shown.has(target.environmentId));
}

export const loadCatalogRoute = (
  profiles: ConnectionProfileStore.ConnectionProfileStore["Service"],
) =>
  Effect.fn("EnvironmentRegistry.loadRoute")(function* (target: ConnectionTarget) {
    const profile: Option.Option<ConnectionProfile> =
      target._tag === "BearerConnectionTarget" ||
      target._tag === "SshConnectionTarget" ||
      target._tag === "HubProxyConnectionTarget" ||
      target._tag === "PenConnectionTarget"
        ? yield* profiles.get(target.connectionId)
        : Option.none();
    return { target, profile } satisfies ConnectionRoute;
  });

export function withRoutes(
  previous: ConnectionCatalogEntry,
  routes: ReadonlyArray<ConnectionRoute>,
) {
  const next = entryWithRoutes(previous, routes);
  if (pullRequestRoutingConnectionKey(previous) === pullRequestRoutingConnectionKey(next)) {
    return { entry: next, addressesChanged: false };
  }
  const { unsupportedReason: _reason, serverUpdateRequired: _update, ...rest } = next;
  return { entry: rest, addressesChanged: true };
}

/** A copy of a registry map or set without one environment. */
export function withoutKey<K, C extends ReadonlyMap<K, unknown> | ReadonlySet<K>>(
  current: C,
  key: K,
): C {
  const next = (current instanceof Map ? new Map(current) : new Set(current as ReadonlySet<K>)) as
    | Map<K, unknown>
    | Set<K>;
  next.delete(key);
  return next as unknown as C;
}
