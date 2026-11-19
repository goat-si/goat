import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type { ConnectionCatalogEntry, ConnectionProfile, ConnectionRoute } from "./catalog.ts";
import type { ConnectionTarget } from "./model.ts";
import type * as ConnectionProfileStore from "./profileStore.ts";
import { pullRequestRoutingConnectionKey } from "./pullRequestRoutingPermissions.ts";
import { connectionRouteId, entryWithRoutes, routeIsShown } from "./routes.ts";

/** A saved environment's live entry holds only the routes the Pen gate shows; none, no entry. */
export function savedCatalogEntry(loaded: ReadonlyArray<ConnectionRoute>, enabled: boolean) {
  const seen = new Set<string>();
  const shown = loaded.filter((route) => {
    const id = connectionRouteId(route.target);
    if (seen.has(id)) return false;
    seen.add(id);
    return routeIsShown(route);
  });
  // As on dev, among the shown routes: none usable keeps the first.
  const usable = shown.filter(
    (route) =>
      !(connectionRouteId(route.target).startsWith("learned:") && Option.isNone(route.profile)),
  );
  const routes = usable.length > 0 ? usable : shown.slice(0, 1);
  const first = routes[0];
  return first === undefined
    ? undefined
    : entryWithRoutes({ target: first.target, profile: first.profile, enabled }, routes);
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
