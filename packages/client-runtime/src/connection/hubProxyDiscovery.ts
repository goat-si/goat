import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
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
import { ConnectionCredentialStore } from "./credentialStore.ts";
import {
  HubProxyConnectionTarget,
  hubProxyConnectionId,
  type PreparedConnection,
} from "./model.ts";
import { EnvironmentRegistry } from "./registry.ts";
import {
  connectionRouteId,
  connectionRoutes,
  credentialConnectionId,
  sendsTokenInClear,
} from "./routes.ts";

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
      profile.hubEnvironmentId === input.hubEnvironmentId &&
      profile.hubConnectionId === input.hubConnectionId
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
  readonly config?: Pick<ServerConfig, "environment">;
}

export const watchHubProxyDiscovery = <E, R>(
  updates: Stream.Stream<HubProxyDiscoveryUpdate, E, R>,
) =>
  Effect.gen(function* () {
    const registry = yield* EnvironmentRegistry;
    yield* updates.pipe(
      Stream.runForEach((update) =>
        Effect.gen(function* () {
          const authorized =
            update.sessionScopes.includes(AuthHubProxyScope) &&
            update.config?.environment.capabilities.hubProxy === true;
          const entries = yield* SubscriptionRef.get(registry.entries);
          if (!entries.has(update.hubEnvironmentId)) return;
          // Without hub:proxy, device routes stay as they are: one bound to another pairing may
          // still work, and one bound to this route shows the hub's refusal.
          if (!authorized && update.config?.environment.capabilities.hubProxy === true) return;
          if (authorized && (yield* registry.state(update.hubEnvironmentId)).phase !== "connected")
            return;
          const changes = reconcileHubProxyRoutes({
            ...update,
            nodes: authorized ? update.nodes : [],
            existing: [...entries.values()],
          });
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
  const credentials = yield* ConnectionCredentialStore;
  const watchers = new Map<EnvironmentId, Fiber.Fiber<void>>();
  const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
  // Pairing the hub again at another address saves a second session beside the first, and route
  // order can pick the one without hub:proxy. The active credential then takes the saved one that
  // has it unless that token would travel over plain HTTP. Device routes read it from the store;
  // the live socket keeps its session, and with it its permissions, until it reconnects.
  const adoptSavedHubAccess = Effect.fn("HubProxyDiscovery.adoptSavedHubAccess")(function* (
    prepared: PreparedConnection,
  ) {
    const target = prepared.target;
    const current = prepared.httpAuthorization;
    if (target._tag !== "BearerConnectionTarget" || current?._tag !== "Bearer")
      return Option.none<ReadonlyArray<AuthEnvironmentScope>>();
    const entry = (yield* SubscriptionRef.get(registry.entries)).get(target.environmentId);
    const routes = entry === undefined ? [] : connectionRoutes(entry);
    const activeCredentialId = credentialConnectionId(target.connectionId);
    const sharing = routes.filter(
      (route) => credentialConnectionId(connectionRouteId(route.target)) === activeCredentialId,
    );
    // The active credential comes first: an earlier adoption may already have replaced it.
    const candidates = new Set([
      activeCredentialId,
      ...routes.flatMap((route) =>
        route.target._tag === "BearerConnectionTarget"
          ? [credentialConnectionId(connectionRouteId(route.target))]
          : [],
      ),
    ]);
    for (const credentialId of candidates) {
      if (sharing.some((shared) => sendsTokenInClear(routes, shared, undefined, credentialId)))
        continue;
      const saved = Option.getOrUndefined(
        yield* credentials.get(credentialId).pipe(Effect.orElseSucceed(() => Option.none())),
      );
      if (saved === undefined || saved.token === current.token) continue;
      const state = yield* fetchEnvironmentSessionState({
        prepared: { ...prepared, httpAuthorization: { _tag: "Bearer", token: saved.token } },
        signer,
        remoteAuthorization,
      }).pipe(Effect.catchIf(isTerminalDiscoveryError, () => Effect.void));
      if (state === undefined || !state.authenticated) continue;
      const scopes = state.permissions ?? state.scopes ?? [];
      if (!scopes.includes(AuthHubProxyScope)) continue;
      if (credentialId === activeCredentialId) return Option.some(scopes);
      const written = yield* credentials.put(activeCredentialId, saved, current.token).pipe(
        Effect.andThen(credentials.get(activeCredentialId)),
        Effect.map((stored) => Option.isSome(stored) && stored.value.token === saved.token),
        Effect.catch((error) =>
          Effect.logWarning("Could not save the hub credential that has hub access.", {
            error,
          }).pipe(Effect.as(false)),
        ),
      );
      if (!written) return Option.none<ReadonlyArray<AuthEnvironmentScope>>();
      yield* Effect.logInfo("Using the saved hub credential that has hub access.", {
        environmentId: target.environmentId,
        connectionId: activeCredentialId,
        from: credentialId,
      });
      return Option.some(scopes);
    }
    return Option.none<ReadonlyArray<AuthEnvironmentScope>>();
  });
  const updates = (environmentId: EnvironmentId) => {
    let lastUpdate: HubProxyDiscoveryUpdate | undefined;
    return registry.followStream(
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
                return {
                  session:
                    state.phase === "connected"
                      ? yield* SubscriptionRef.get(supervisor.session)
                      : Option.none(),
                  denied:
                    state.phase === "blocked" &&
                    (state.lastFailure?.reason === "authentication" ||
                      state.lastFailure?.reason === "permission"),
                };
              }),
            ),
            Stream.changesWith(
              (left, right) =>
                Option.getOrNull(left.session) === Option.getOrNull(right.session) &&
                left.denied === right.denied,
            ),
            Stream.switchMap(({ session: current, denied }) => {
              if (Option.isNone(current)) {
                if (!denied) return Stream.empty;
                return Stream.fromEffect(
                  Effect.gen(function* () {
                    if (lastUpdate !== undefined)
                      return Option.some({ ...lastUpdate, nodes: [], sessionScopes: [] });
                    const prepared = yield* SubscriptionRef.get(supervisor.prepared);
                    const target = Option.isSome(prepared)
                      ? prepared.value.target
                      : supervisor.target;
                    if (
                      target._tag !== "PrimaryConnectionTarget" &&
                      target._tag !== "BearerConnectionTarget" &&
                      target._tag !== "RelayConnectionTarget"
                    )
                      return Option.none();
                    return Option.some({
                      hubEnvironmentId: target.environmentId,
                      hubConnectionId: connectionRouteId(target),
                      hubLabel: target.label,
                      nodes: [],
                      sessionScopes: [],
                    } satisfies HubProxyDiscoveryUpdate);
                  }),
                ).pipe(
                  Stream.filter(Option.isSome),
                  Stream.map((update) => update.value),
                );
              }
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
                      const prepared = yield* SubscriptionRef.get(supervisor.prepared);
                      if (Option.isNone(prepared)) return Stream.empty;
                      const target = prepared.value.target;
                      if (
                        target._tag !== "PrimaryConnectionTarget" &&
                        target._tag !== "BearerConnectionTarget" &&
                        target._tag !== "RelayConnectionTarget"
                      )
                        return Stream.empty;
                      const emptyUpdate = Effect.gen(function* () {
                        const entries = yield* SubscriptionRef.get(registry.entries);
                        return {
                          hubEnvironmentId: target.environmentId,
                          hubConnectionId: connectionRouteId(target),
                          hubLabel:
                            entries.get(environmentId)?.target.label ?? config.environment.label,
                          nodes: [],
                          sessionScopes: [],
                          config,
                        } satisfies HubProxyDiscoveryUpdate;
                      });
                      if (config.environment.capabilities.hubProxy !== true)
                        return Stream.fromEffect(emptyUpdate);
                      const subscribeNodes = session.client[WS_METHODS.hubNodesSubscribe];
                      if (typeof subscribeNodes !== "function") return Stream.empty;
                      const auth = yield* fetchEnvironmentSessionState({
                        prepared: prepared.value,
                        signer,
                        remoteAuthorization,
                      }).pipe(
                        Effect.catchIf(isTerminalDiscoveryError, () =>
                          Effect.succeed({ authenticated: false, permissions: [], scopes: [] }),
                        ),
                      );
                      const ownScopes = auth.authenticated
                        ? (auth.permissions ?? auth.scopes ?? [])
                        : [];
                      const sessionScopes = ownScopes.includes(AuthHubProxyScope)
                        ? ownScopes
                        : Option.getOrElse(
                            yield* adoptSavedHubAccess(prepared.value),
                            () => ownScopes,
                          );
                      if (!sessionScopes.includes(AuthHubProxyScope))
                        return Stream.fromEffect(emptyUpdate);
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
                        Stream.tap((update) =>
                          Effect.sync(() => {
                            lastUpdate = update;
                          }),
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
  };
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
