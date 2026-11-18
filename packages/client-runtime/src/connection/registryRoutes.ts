import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import { pullRequestRoutingConnectionKey } from "./pullRequestRoutingPermissions.ts";
import { entryWithRoutes } from "./routes.ts";

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
