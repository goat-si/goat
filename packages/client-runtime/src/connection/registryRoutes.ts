import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  PenConnectionRegistration,
  type ConnectionCatalogEntry,
  type ConnectionProfile,
  type ConnectionRoute,
} from "./catalog.ts";
import type { ConnectionTarget } from "./model.ts";
import type * as ConnectionProfileStore from "./profileStore.ts";
import { pullRequestRoutingConnectionKey } from "./pullRequestRoutingPermissions.ts";
import { connectionRouteId, entryWithRoutes, routeIsShown } from "./routes.ts";

/** A saved route the closed Pen gate hides, and its slot among the environment's saved routes. */
export interface HiddenRoute {
  readonly index: number;
  readonly route: ConnectionRoute;
}

export function splitHiddenRoutes(routes: ReadonlyArray<ConnectionRoute>) {
  const shown: Array<ConnectionRoute> = [];
  const hidden: Array<HiddenRoute> = [];
  routes.forEach((route, index) =>
    routeIsShown(route) ? shown.push(route) : hidden.push({ index, route }),
  );
  return { shown, hidden };
}

/** The routes to save: the live ones in their order, each hidden one back in its slot. */
export function withHiddenRoutes(
  shown: ReadonlyArray<ConnectionRoute>,
  hidden: ReadonlyArray<HiddenRoute>,
): ReadonlyArray<ConnectionRoute> {
  const routes = [...shown];
  for (const { index, route } of hidden) routes.splice(Math.min(index, routes.length), 0, route);
  return routes;
}

/** The hidden Pen routes that can be saved again on their own: each with its own profile. */
export function hiddenPenRegistrations(hidden: ReadonlyArray<HiddenRoute> = []) {
  return hidden.flatMap(({ route: { target, profile } }) =>
    target._tag === "PenConnectionTarget" &&
    Option.isSome(profile) &&
    profile.value._tag === "PenConnectionProfile"
      ? [new PenConnectionRegistration({ target, profile: profile.value })]
      : [],
  );
}

export const hiddenRouteOf = (registration: PenConnectionRegistration, index: number) => ({
  index,
  route: { target: registration.target, profile: Option.some(registration.profile) },
});

/** A saved environment's live entry holds only the routes the Pen gate shows; none, no entry. */
export function savedCatalogEntry(loaded: ReadonlyArray<ConnectionRoute>, enabled: boolean) {
  const seen = new Set<string>();
  const usable = loaded.filter((route) => {
    const id = connectionRouteId(route.target);
    if (seen.has(id)) return false;
    seen.add(id);
    return !(id.startsWith("learned:") && Option.isNone(route.profile));
  });
  const { shown, hidden } = splitHiddenRoutes(usable.length > 0 ? usable : loaded.slice(0, 1));
  const first = shown[0];
  const entry =
    first === undefined
      ? undefined
      : entryWithRoutes({ target: first.target, profile: first.profile, enabled }, shown);
  return { entry, hidden };
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
