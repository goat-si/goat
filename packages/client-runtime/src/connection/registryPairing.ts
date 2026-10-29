import type { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { ConnectionCatalogEntry, ConnectionRoute } from "./catalog.ts";
import { ConnectionBlockedError } from "./model.ts";
import { connectionRoutes, findRouteToSameAddress } from "./routes.ts";

export function unsupportedState(
  entry: ConnectionCatalogEntry,
): Pick<ConnectionCatalogEntry, "unsupportedReason" | "serverUpdateRequired"> {
  return {
    ...(entry.unsupportedReason === undefined
      ? {}
      : { unsupportedReason: entry.unsupportedReason }),
    ...(entry.serverUpdateRequired === true ? { serverUpdateRequired: true } : {}),
  };
}

export const makeKnownAddressCheck = (
  platformEnvironmentIds: Ref.Ref<ReadonlySet<EnvironmentId>>,
  entries: SubscriptionRef.SubscriptionRef<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>,
) =>
  Effect.fn("EnvironmentRegistry.assertKnownAddress")(function* (route: ConnectionRoute) {
    const environmentId = route.target.environmentId;
    if ((yield* Ref.get(platformEnvironmentIds)).has(environmentId)) return;
    const saved = (yield* SubscriptionRef.get(entries)).get(environmentId);
    if (
      saved !== undefined &&
      findRouteToSameAddress(connectionRoutes(saved), route) === undefined
    ) {
      return yield* new ConnectionBlockedError({
        reason: "configuration",
        detail: `That address claims to be ${saved.target.label}, which is already saved. Add it as a route from that environment's settings instead.`,
      });
    }
  });
