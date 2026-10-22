import * as Fiber from "effect/Fiber";
import { EnvironmentSupervisor } from "./supervisor.ts";
import { fetchEnvironmentSessionState } from "../state/session.ts";
import {
  WS_METHODS,
  AuthHubProxyScope,
  EnvironmentAuthorizationError,
  EnvironmentHttpCommonError,
  HubNodesError,
  type AuthEnvironmentScope,
  type EnvironmentId,
  type ServerConfig,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { RpcClientError } from "effect/rpc";
import { RemoteEnvironmentAuthUndeclaredStatusError } from "../rpc/http.ts";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  HubProxyConnectionProfile,
  HubProxyConnectionRegistration,
  type ConnectionCatalogEntry,
} from "./catalog.ts";
import { HubProxyConnectionTarget, hubProxyConnectionId } from "./model.ts";
import { EnvironmentRegistry } from "./registry.ts";
import { connectionRouteId, connectionRoutes } from "./routes.ts";

export interface HubProxyNode {
  readonly nodeId: string;
  readonly environmentId: EnvironmentId | null;
  readonly label: string;
}

export function reconcileHubProxyRoutes(input: {
  readonly hubEnvironmentId: EnvironmentId;
  readonly hubConnectionId: string;
  readonly hubLabel: string;
  readonly nodes: ReadonlyArray<HubProxyNode>;
  readonly existing: ReadonlyArray<ConnectionCatalogEntry>;
}) {
  const existing = input.existing.flatMap(connectionRoutes).filter((route) => {
    const profile = Option.getOrNull(route.profile);
    return (
      profile?._tag === "HubProxyConnectionProfile" &&
      profile.hubEnvironmentId === input.hubEnvironmentId
    );
  });
  const register: HubProxyConnectionRegistration[] = [];
  const kept = new Set<string>();
  for (const node of input.nodes) {
    if (node.environmentId === null || node.environmentId === input.hubEnvironmentId) continue;
    const connectionId = hubProxyConnectionId(input.hubEnvironmentId, node.nodeId);
    if (kept.has(connectionId)) continue;
    kept.add(connectionId);
    const previous = existing.find((route) => connectionRouteId(route.target) === connectionId);
    const profile = previous === undefined ? null : Option.getOrNull(previous.profile);
    if (
      previous?.target.environmentId === node.environmentId &&
      previous.target.label === node.label &&
      profile?._tag === "HubProxyConnectionProfile" &&
      profile.environmentId === node.environmentId &&
      profile.connectionId === connectionId &&
      profile.label === node.label &&
      profile.hubConnectionId === input.hubConnectionId &&
      profile.hubLabel === input.hubLabel &&
      profile.nodeId === node.nodeId
    )
      continue;
    register.push(
      new HubProxyConnectionRegistration({
        target: new HubProxyConnectionTarget({
          connectionId,
          environmentId: node.environmentId,
          label: node.label,
        }),
        profile: new HubProxyConnectionProfile({
          connectionId,
          environmentId: node.environmentId,
          label: node.label,
          hubEnvironmentId: input.hubEnvironmentId,
          hubConnectionId: input.hubConnectionId,
          hubLabel: input.hubLabel,
          nodeId: node.nodeId,
        }),
      }),
    );
  }
  return {
    register,
    remove: existing.flatMap((route) => {
      const id = connectionRouteId(route.target);
      const replacement = register.find((registration) => registration.target.connectionId === id);
      return !kept.has(id) ||
        (replacement !== undefined &&
          replacement.target.environmentId !== route.target.environmentId)
        ? [id]
        : [];
    }),
  };
}

export interface HubProxyDiscoveryUpdate {
  readonly hubEnvironmentId: EnvironmentId;
  readonly hubConnectionId: string;
  readonly hubLabel: string;
  readonly nodes: ReadonlyArray<HubProxyNode>;
  readonly sessionScopes: ReadonlyArray<AuthEnvironmentScope>;
  readonly config: Pick<ServerConfig, "environment">;
}

export const watchHubProxyDiscovery = <E, R>(
  updates: Stream.Stream<HubProxyDiscoveryUpdate, E, R>,
) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    yield* updates.pipe(
      Stream.runForEach((update) =>
        Effect.gen(function* () {
          if (
            !update.sessionScopes.includes(AuthHubProxyScope) ||
            update.config.environment.capabilities.hubProxy !== true
          )
            return;
          const entries = yield* SubscriptionRef.get(registry.entries);
          if (!entries.has(update.hubEnvironmentId)) return;
          if ((yield* registry.state(update.hubEnvironmentId)).phase !== "connected") return;
          const changes = reconcileHubProxyRoutes({ ...update, existing: [...entries.values()] });
          for (const id of changes.remove) {
            for (const entry of entries.values())
              if (connectionRoutes(entry).some((route) => connectionRouteId(route.target) === id)) {
                yield* registry.removeRoute(entry.target.environmentId, id);
              }
          }
          for (const registration of changes.register) yield* registry.register(registration);
        }).pipe(
          Effect.catch((error) =>
            Effect.logWarning("Could not reconcile hub proxy routes.", { error }),
          ),
        ),
      ),
    );
  });

export const watchRemovedHubProxyRoutes = (
  changes?: Stream.Stream<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>,
) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    let previous = new Set<EnvironmentId>();
    yield* (changes ?? SubscriptionRef.changes(registry.entries)).pipe(
      Stream.runForEach((entries) =>
        Effect.gen(function* () {
          // Primary registrations arrive asynchronously, so absence at startup is not removal.
          const removed = new Set(
            [...previous].filter((environmentId) => !entries.has(environmentId)),
          );
          previous = new Set(entries.keys());
          if (removed.size === 0) return;
          for (const entry of entries.values())
            for (const route of connectionRoutes(entry)) {
              const profile = Option.getOrNull(route.profile);
              if (
                profile?._tag === "HubProxyConnectionProfile" &&
                removed.has(profile.hubEnvironmentId)
              ) {
                yield* registry
                  .removeRoute(entry.target.environmentId, connectionRouteId(route.target))
                  .pipe(
                    Effect.catch((error) =>
                      Effect.logWarning("Could not remove a route through a forgotten hub.", {
                        error,
                      }),
                    ),
                  );
              }
            }
        }),
      ),
    );
  });

const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);
const isEnvironmentHttpCommonError = Schema.is(EnvironmentHttpCommonError);
const isHubNodesError = Schema.is(HubNodesError);
const isRpcClientError = Schema.is(RpcClientError.RpcClientError);

const isTerminalDiscoveryError = (error: unknown): boolean => {
  if (isEnvironmentAuthorizationError(error)) return true;
  if (isEnvironmentHttpCommonError(error)) return error._tag !== "EnvironmentInternalError";
  if (isHubNodesError(error))
    return error.reason !== "host_unavailable" && error.reason !== "storage_failed";
  if (error instanceof RemoteEnvironmentAuthUndeclaredStatusError)
    return [401, 403, 404, 405, 501].includes(error.status);
  return isRpcClientError(error) && error.reason._tag === "RpcClientDefect";
};

const discoveryRetry = Schedule.spaced("1 second").pipe(
  Schedule.modifyDelay(({ attempt }) =>
    Effect.succeed(Math.min(1000 * 2 ** Math.min(attempt - 1, 5), 30_000)),
  ),
  Schedule.while(({ input }) => !isTerminalDiscoveryError(input)),
);

export const watchConnectedHubProxyDiscovery = Effect.gen(function* () {
  const registry = yield* EnvironmentRegistry;
  const watchers = new Map<EnvironmentId, Fiber.Fiber<void>>();
  const updates = (environmentId: EnvironmentId) =>
    registry.followStream(
      environmentId,
      Stream.unwrap(
        Effect.gen(function* () {
          const supervisor = yield* EnvironmentSupervisor;
          return Stream.merge(
            SubscriptionRef.changes(supervisor.session),
            SubscriptionRef.changes(supervisor.state),
          ).pipe(
            Stream.mapEffect(() =>
              Effect.gen(function* () {
                const state = yield* SubscriptionRef.get(supervisor.state);
                return state.phase === "connected"
                  ? yield* SubscriptionRef.get(supervisor.session)
                  : Option.none();
              }),
            ),
            Stream.changesWith((left, right) => Option.getOrNull(left) === Option.getOrNull(right)),
            Stream.switchMap((current) => {
              if (Option.isNone(current)) return Stream.empty;
              const session = current.value;
              return Stream.fromEffect(session.initialConfig).pipe(
                Stream.merge(
                  session.subscribeServerConfig({}).pipe(
                    Stream.filter((event) => event.type === "snapshot"),
                    Stream.map((event) => event.config),
                    Stream.catch(() => Stream.empty),
                  ),
                ),
                Stream.changesWith((left, right) => left === right),
                Stream.switchMap((config) =>
                  Stream.unwrap(
                    Effect.gen(function* () {
                      if (config.environment.capabilities.hubProxy !== true) return Stream.empty;
                      const prepared = yield* SubscriptionRef.get(supervisor.prepared);
                      if (Option.isNone(prepared)) return Stream.empty;
                      const target = prepared.value.target;
                      if (
                        target._tag !== "PrimaryConnectionTarget" &&
                        target._tag !== "BearerConnectionTarget"
                      )
                        return Stream.empty;
                      if (prepared.value.httpAuthorization?._tag === "Dpop") return Stream.empty;
                      const subscribeNodes = session.client[WS_METHODS.hubNodesSubscribe];
                      if (typeof subscribeNodes !== "function") return Stream.empty;
                      const auth = yield* fetchEnvironmentSessionState({
                        prepared: prepared.value,
                        signer: Option.none(),
                      });
                      const sessionScopes = auth.permissions ?? auth.scopes ?? [];
                      if (!auth.authenticated || !sessionScopes.includes(AuthHubProxyScope))
                        return Stream.empty;
                      return subscribeNodes({}).pipe(
                        Stream.filter(
                          (snapshot) => snapshot.hubEnvironmentId === target.environmentId,
                        ),
                        Stream.mapEffect((snapshot) =>
                          SubscriptionRef.get(registry.entries).pipe(
                            Effect.map((entries): HubProxyDiscoveryUpdate => ({
                              hubEnvironmentId: target.environmentId,
                              hubConnectionId: connectionRouteId(target),
                              hubLabel:
                                entries.get(environmentId)?.target.label ??
                                config.environment.label,
                              nodes: snapshot.nodes,
                              sessionScopes,
                              config,
                            })),
                          ),
                        ),
                      );
                    }),
                  ).pipe(
                    Stream.retry(discoveryRetry),
                    Stream.catch((error) =>
                      Stream.fromEffect(
                        Effect.logDebug("Hub node discovery is unavailable for this session.", {
                          error,
                        }),
                      ).pipe(Stream.drain),
                    ),
                  ),
                ),
                Stream.catch((error) =>
                  Stream.fromEffect(
                    Effect.logDebug(
                      "Hub discovery configuration is unavailable for this session.",
                      { error },
                    ),
                  ).pipe(Stream.drain),
                ),
              );
            }),
          );
        }),
      ),
    );
  yield* SubscriptionRef.changes(registry.entries).pipe(
    Stream.runForEach((entries) =>
      Effect.gen(function* () {
        for (const [environmentId, watcher] of watchers) {
          if (entries.get(environmentId)?.enabled === true) continue;
          yield* Fiber.interrupt(watcher);
          watchers.delete(environmentId);
        }
        for (const [environmentId, entry] of entries) {
          if (!entry.enabled || watchers.has(environmentId)) continue;
          watchers.set(
            environmentId,
            yield* watchHubProxyDiscovery(updates(environmentId)).pipe(Effect.forkScoped),
          );
        }
      }),
    ),
  );
});
