import type { EnvironmentId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as SubscriptionRef from "effect/SubscriptionRef";
import type { ConnectionCatalogEntry } from "./catalog.ts";
import type { EnvironmentSupervisor } from "./supervisor.ts";
import { connectionRoutes, penRouteOwner } from "./routes.ts";

/** Every route of the entry is one GOAT added for a Pen member; a machine the person also added is not. */
export function isPenOnlyEntry(entry: ConnectionCatalogEntry): boolean {
  return connectionRoutes(entry).every(
    (route) =>
      route.target._tag === "SshConnectionTarget" &&
      penRouteOwner(route.target.connectionId) !== null,
  );
}

export function makePenGate<
  L extends { readonly supervisor: EnvironmentSupervisor["Service"] },
>(deps: {
  entries: SubscriptionRef.SubscriptionRef<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>;
  serviceScopes: SubscriptionRef.SubscriptionRef<ReadonlyMap<EnvironmentId, L>>;
  withLeaseLock: <A, E, R>(
    id: EnvironmentId,
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, R>;
  forkSshTeardown: (entry: ConnectionCatalogEntry) => Effect.Effect<void>;
}) {
  let liveIds: ReadonlySet<EnvironmentId> = new Set();
  const mayConnect = (entry: ConnectionCatalogEntry) =>
    !isPenOnlyEntry(entry) || liveIds.has(entry.target.environmentId);
  // Uninterruptible: the set and the supervisors it was pushed to must not part ways halfway.
  const setLive = (ids: ReadonlySet<EnvironmentId>) => Effect.uninterruptible(pushLive(ids));
  const pushLive = Effect.fn("PenGate.setLive")(function* (ids: ReadonlySet<EnvironmentId>) {
    // Every other path that turns a supervisor on asks mayConnect, so only a changed id needs a push.
    const previous = liveIds;
    liveIds = new Set(ids);
    const entries = yield* SubscriptionRef.get(deps.entries);
    for (const candidate of entries.values()) {
      const id = candidate.target.environmentId;
      if (!isPenOnlyEntry(candidate) || previous.has(id) === liveIds.has(id)) continue;
      yield* deps.withLeaseLock(
        id,
        Effect.gen(function* () {
          const entry = (yield* SubscriptionRef.get(deps.entries)).get(id);
          const lease = (yield* SubscriptionRef.get(deps.serviceScopes)).get(id);
          if (entry === undefined || lease === undefined || !isPenOnlyEntry(entry)) return;
          if (mayConnect(entry)) {
            if (entry.enabled && entry.unsupportedReason === undefined)
              yield* lease.supervisor.connect;
          } else {
            yield* lease.supervisor.disconnect;
            yield* deps.forkSshTeardown(entry);
          }
        }),
      );
    }
  });
  return { mayConnect, setLive };
}
