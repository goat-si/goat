import {
  type ConnectionTarget,
  connectionRouteId,
  connectionRouteKind,
  connectionRouteLabel,
  connectionRoutes,
  usableRoutes,
  type ConnectionCatalogEntry,
  type ConnectionRoute,
} from "@goat/client-runtime/connection";
import type { DesktopSshEnvironmentTarget } from "@goat/contracts";
import * as Option from "effect/Option";

import type { EnvironmentPresentation } from "~/state/environments";
import { isDesktopLocalConnectionTarget, isWslConnectionTarget } from "~/connection/desktopLocal";
import { GOAT_CONNECT_COMING_SOON, isGoatConnectEnabled } from "@goat/shared/goatConnect";

export function isGoatConnectUnavailable(entry: ConnectionCatalogEntry): boolean {
  return (
    !isGoatConnectEnabled() &&
    usableRoutes(entry).length === 0 &&
    connectionRoutes(entry).some((route) => {
      const profile = Option.getOrNull(route.profile);
      return (
        route.target._tag === "RelayConnectionTarget" ||
        (profile?._tag === "BearerConnectionProfile" && profile.authorization === "t3-connect")
      );
    })
  );
}

export function savedConnectionRouteLabel(route: ConnectionRoute): string {
  return isGoatConnectUnavailable({ ...route, enabled: true })
    ? `${GOAT_CONNECT_COMING_SOON.title} · ${GOAT_CONNECT_COMING_SOON.status}`
    : connectionRouteLabel(route);
}

export function formatDesktopSshTarget(target: DesktopSshEnvironmentTarget): string {
  const authority = target.username ? `${target.username}@${target.hostname}` : target.hostname;
  return target.port ? `${authority}:${target.port}` : authority;
}

export function environmentTransportLabel(
  environment: EnvironmentPresentation,
  activeTarget: ConnectionTarget | null = null,
): string {
  const { entry } = environment;
  if (entry.target._tag === "PrimaryConnectionTarget") return "This machine";
  if (isGoatConnectUnavailable(entry))
    return `${GOAT_CONNECT_COMING_SOON.title} · ${GOAT_CONNECT_COMING_SOON.status}`;
  const routes = isGoatConnectEnabled() ? connectionRoutes(entry) : usableRoutes(entry);
  if (
    routes.length > 1 ||
    (!isGoatConnectEnabled() && routes.length === 1 && connectionRoutes(entry).length > 1)
  ) {
    const active =
      activeTarget === null
        ? undefined
        : routes.find(
            (route) => connectionRouteId(route.target) === connectionRouteId(activeTarget),
          );
    return active === undefined
      ? connectionRouteLabel(routes[0]!)
      : connectionRouteKind(active) === "hub-proxy"
        ? connectionRouteLabel(active)
        : `via ${connectionRouteLabel(active)}`;
  }
  if (environment.relayManaged && isGoatConnectEnabled()) return "GOAT Connect";
  // Already reads "via <hub>".
  if (entry.target._tag === "HubProxyConnectionTarget" && routes[0] !== undefined)
    return connectionRouteLabel(routes[0]);
  if (isDesktopLocalConnectionTarget(entry.target))
    return isWslConnectionTarget(entry.target) ? "WSL" : "Local device";
  if (
    entry.target._tag === "SshConnectionTarget" &&
    Option.isSome(entry.profile) &&
    entry.profile.value._tag === "SshConnectionProfile"
  ) {
    return `SSH ${formatDesktopSshTarget(entry.profile.value.target)}`;
  }
  return environment.displayUrl ?? "Remote link";
}
