import { EnvironmentSupervisor } from "./supervisor.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import type { PreparedConnection, SupervisorConnectionState } from "./model.ts";
import {
  AuthHubProxyScope,
  EnvironmentId,
  ExecutionEnvironmentDescriptor,
  HubNodesError,
  WS_METHODS,
  type AuthSessionState,
  type HubNodesSnapshot,
  type ServerConfig,
  type AuthEnvironmentScope,
} from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import {
  HubProxyConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRegistration,
} from "./catalog.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  HubProxyConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
} from "./model.ts";
import { EnvironmentRegistry } from "./registry.ts";
import {
  watchConnectedHubProxyDiscovery,
  watchHubProxyDiscovery,
  watchRemovedHubProxyRoutes,
} from "./hubProxyDiscovery.ts";

const decodeDescriptor = Schema.decodeUnknownEffect(ExecutionEnvironmentDescriptor);

const HUB = EnvironmentId.make("hub");
const NODE = EnvironmentId.make("node");
const node: ConnectionCatalogEntry = {
  target: new HubProxyConnectionTarget({
    environmentId: NODE,
    label: "Node",
    connectionId: "hub:hub:node",
  }),
  profile: Option.some(
    new HubProxyConnectionProfile({
      connectionId: "hub:hub:node",
      environmentId: NODE,
      label: "Node",
      hubEnvironmentId: HUB,
      hubConnectionId: "primary",
      nodeId: "node",
    }),
  ),
  enabled: false,
};
const hub: ConnectionCatalogEntry = {
  target: new RelayConnectionTarget({ environmentId: HUB, label: "Hub" }),
  profile: Option.none(),
  enabled: true,
};

const makeRegistry = Effect.gen(function* () {
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map([
      [HUB, hub],
      [NODE, node],
    ]),
  );
  const removed = yield* Deferred.make<string>();
  const registered: string[] = [];
  // Only the coordinator's registry boundary is faked; route decisions and lifecycle streams run normally.
  const registry = EnvironmentRegistry.of({
    entries,
    state: () => Effect.succeed({ ...AVAILABLE_CONNECTION_STATE, phase: "connected" }),
    register: (registration: ConnectionRegistration) =>
      Effect.sync(() => {
        registered.push(registration.target.environmentId);
        return true;
      }),
    removeRoute: (_id: EnvironmentId, routeId: string) =>
      Deferred.succeed(removed, routeId).pipe(Effect.asVoid),
  } as unknown as EnvironmentRegistry["Service"]);
  return { registry, entries, removed, registered };
});

const makeConnectedDiscovery = Effect.fn(function* (options: {
  readonly failReads?: number;
  readonly failSubscriptions?: number;
  readonly scopes?: readonly AuthEnvironmentScope[];
  readonly subscriptionError?: HubNodesError;
  readonly capability?: boolean;
  readonly missingMethod?: boolean;
}) {
  const h = yield* makeRegistry;
  const firstRead = yield* Deferred.make<void>();
  const subscribed = yield* Deferred.make<void>();
  const reconciled = yield* Deferred.make<void>();
  let reads = 0;
  let subscriptions = 0;
  const target = new PrimaryConnectionTarget({
    environmentId: HUB,
    label: "Hub",
    httpBaseUrl: "https://hub.test",
    wsBaseUrl: "wss://hub.test",
  });
  const environment = yield* decodeDescriptor({
    environmentId: HUB,
    label: "Hub",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "1",
    capabilities: { hubProxy: options.capability ?? true },
  });
  const snapshot: HubNodesSnapshot = { hubEnvironmentId: HUB, nodes: [], notices: [] };
  const config = { environment } as ServerConfig;
  const configs = yield* SubscriptionRef.make(config);
  const session: RpcSession = {
    client: options.missingMethod
      ? ({} as WsRpcProtocolClient)
      : ({
          [WS_METHODS.hubNodesSubscribe]: () =>
            Stream.unwrap(
              Effect.gen(function* () {
                subscriptions++;
                yield* Deferred.succeed(subscribed, undefined);
                return subscriptions <= (options.failSubscriptions ?? 0)
                  ? Stream.fail(
                      options.subscriptionError ??
                        new HubNodesError({ reason: "host_unavailable", detail: "Try again" }),
                    )
                  : Stream.make(snapshot).pipe(Stream.concat(Stream.never));
              }),
            ),
        } as unknown as WsRpcProtocolClient),
    initialConfig: Effect.succeed(config),
    subscribeServerConfig: () =>
      SubscriptionRef.changes(configs).pipe(
        Stream.map((config) => ({ version: 1 as const, type: "snapshot" as const, config })),
      ),
    ready: Effect.void,
    probe: Effect.void,
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.of({
    target,
    state: yield* SubscriptionRef.make<SupervisorConnectionState>({
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected",
    }),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
      Option.some({
        environmentId: HUB,
        label: "Hub",
        target,
        httpBaseUrl: target.httpBaseUrl,
        socketUrl: target.wsBaseUrl,
        httpAuthorization: null,
      }),
    ),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const registry = EnvironmentRegistry.of({
    ...h.registry,
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map([[HUB, { ...hub, target }]]),
    ),
    state: () =>
      Deferred.succeed(reconciled, undefined).pipe(
        Effect.as({ ...AVAILABLE_CONNECTION_STATE, phase: "connected" as const }),
      ),
    followStream: (
      _id: EnvironmentId,
      stream: Stream.Stream<unknown, unknown, EnvironmentSupervisor>,
    ) => stream.pipe(Stream.provideService(EnvironmentSupervisor, supervisor)),
  } as unknown as EnvironmentRegistry["Service"]);
  const auth: AuthSessionState = {
    authenticated: true,
    auth: {
      policy: "remote-reachable",
      bootstrapMethods: [],
      sessionMethods: [],
      sessionCookieName: "test",
    },
    scopes: options.scopes ?? [AuthHubProxyScope],
  };
  const httpClient = HttpClient.make((request) =>
    Effect.gen(function* () {
      reads++;
      yield* Deferred.succeed(firstRead, undefined);
      return HttpClientResponse.fromWeb(
        request,
        reads <= (options.failReads ?? 0)
          ? new Response("unavailable", { status: 503 })
          : Response.json(auth),
      );
    }),
  );
  const work = yield* watchConnectedHubProxyDiscovery.pipe(
    Effect.provideService(EnvironmentRegistry, registry),
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.forkScoped,
  );
  return {
    work,
    supervisor,
    session,
    firstRead,
    subscribed,
    reconciled,
    config,
    configs,
    counts: () => ({ reads, subscriptions }),
  };
});

describe("hub proxy discovery coordinator", () => {
  it.effect("keeps a refused subscription terminal until the config changes", () =>
    Effect.gen(function* () {
      const h = yield* makeConnectedDiscovery({
        failSubscriptions: 1,
        subscriptionError: new HubNodesError({ reason: "refused", detail: "Not allowed" }),
      });
      yield* Deferred.await(h.subscribed);
      yield* TestClock.adjust("1 minute");
      expect(h.counts()).toEqual({ reads: 1, subscriptions: 1 });
      yield* SubscriptionRef.set(h.configs, { ...h.config });
      yield* TestClock.adjust(0);
      yield* Deferred.await(h.reconciled);
      expect(h.counts()).toEqual({ reads: 2, subscriptions: 2 });
    }).pipe(Effect.scoped),
  );

  it.effect("starts discovery when a config snapshot enables the hub capability", () =>
    Effect.gen(function* () {
      const h = yield* makeConnectedDiscovery({ capability: false });
      yield* TestClock.adjust("1 minute");
      expect(h.counts()).toEqual({ reads: 0, subscriptions: 0 });
      yield* SubscriptionRef.set(h.configs, {
        ...h.config,
        environment: {
          ...h.config.environment,
          capabilities: { ...h.config.environment.capabilities, hubProxy: true },
        },
      });
      yield* TestClock.adjust(0);
      yield* Deferred.await(h.reconciled);
      expect(h.counts()).toEqual({ reads: 1, subscriptions: 1 });
    }).pipe(Effect.scoped),
  );

  it.effect("does not retry an unsupported hub node method", () =>
    Effect.gen(function* () {
      const h = yield* makeConnectedDiscovery({ missingMethod: true });
      yield* TestClock.adjust("1 minute");
      expect(h.counts()).toEqual({ reads: 0, subscriptions: 0 });
    }).pipe(Effect.scoped),
  );

  it.effect("recovers a failed session-state read without replacing the WS session", () =>
    Effect.gen(function* () {
      const h = yield* makeConnectedDiscovery({ failReads: 1 });
      yield* Deferred.await(h.firstRead);
      yield* TestClock.adjust("999 millis");
      expect(h.counts()).toEqual({ reads: 1, subscriptions: 0 });
      yield* TestClock.adjust("1 milli");
      expect(h.counts()).toEqual({ reads: 2, subscriptions: 1 });
      yield* Deferred.await(h.reconciled);
      expect(Option.getOrNull(yield* SubscriptionRef.get(h.supervisor.session))).toBe(h.session);
    }).pipe(Effect.scoped),
  );

  it.effect("retries a failed hub node subscription with capped exponential backoff", () =>
    Effect.gen(function* () {
      const h = yield* makeConnectedDiscovery({ failSubscriptions: 7 });
      yield* Deferred.await(h.subscribed);
      for (const [index, delay] of [1000, 2000, 4000, 8000, 16000, 30000, 30000].entries()) {
        yield* TestClock.adjust(delay - 1);
        expect(h.counts().subscriptions).toBe(index + 1);
        yield* TestClock.adjust(1);
        expect(h.counts().subscriptions).toBe(index + 2);
      }
      yield* Deferred.await(h.reconciled);
    }).pipe(Effect.scoped),
  );

  it.effect("cancels discovery backoff when the session disconnects", () =>
    Effect.gen(function* () {
      const h = yield* makeConnectedDiscovery({ failReads: 100 });
      yield* Deferred.await(h.firstRead);
      yield* TestClock.adjust("500 millis");
      yield* SubscriptionRef.set(h.supervisor.session, Option.none());
      yield* TestClock.adjust("1 minute");
      expect(h.counts()).toEqual({ reads: 1, subscriptions: 0 });
    }).pipe(Effect.scoped),
  );

  it.effect("does not retry sessions missing hub proxy permission", () =>
    Effect.gen(function* () {
      const h = yield* makeConnectedDiscovery({ scopes: [] });
      yield* Deferred.await(h.firstRead);
      yield* TestClock.adjust("1 minute");
      expect(h.counts()).toEqual({ reads: 1, subscriptions: 0 });
    }).pipe(Effect.scoped),
  );

  it.effect("keeps existing environment subscriptions when another node is registered", () =>
    Effect.gen(function* () {
      const h = yield* makeRegistry;
      const first = yield* Deferred.make<void>();
      const second = yield* Deferred.make<void>();
      const addedId = EnvironmentId.make("added");
      const attached = new Map<EnvironmentId, number>();
      const environment = yield* decodeDescriptor({
        environmentId: HUB,
        label: "Hub",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "1",
        capabilities: {},
      });
      const session: RpcSession = {
        client: {} as WsRpcProtocolClient,
        initialConfig: Effect.succeed({ environment } as never),
        subscribeServerConfig: () => Stream.never,
        ready: Effect.void,
        probe: Effect.void,
        closed: Effect.never,
      };
      const supervisor = EnvironmentSupervisor.of({
        target: hub.target,
        state: yield* SubscriptionRef.make<SupervisorConnectionState>({
          ...AVAILABLE_CONNECTION_STATE,
          phase: "connected" as const,
        }),
        session: yield* SubscriptionRef.make(Option.some(session)),
        prepared: yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(Option.none()),
        connect: Effect.void,
        disconnect: Effect.void,
        retryNow: Effect.void,
      });
      const registry = EnvironmentRegistry.of({
        ...h.registry,
        followStream: (
          id: EnvironmentId,
          stream: Stream.Stream<unknown, unknown, EnvironmentSupervisor>,
        ) =>
          Stream.fromEffect(
            Effect.gen(function* () {
              attached.set(id, (attached.get(id) ?? 0) + 1);
              yield* Deferred.succeed(id === HUB ? first : second, undefined);
            }),
          ).pipe(
            Stream.flatMap(() => stream),
            Stream.provideService(EnvironmentSupervisor, supervisor),
          ),
      } as unknown as EnvironmentRegistry["Service"]);
      const work = yield* watchConnectedHubProxyDiscovery.pipe(
        Effect.provideService(EnvironmentRegistry, registry),
        Effect.provide(
          layerRemoteHttpClient((() =>
            Promise.reject(new Error("Unexpected request"))) satisfies typeof fetch),
        ),
        Effect.forkScoped,
      );
      yield* Deferred.await(first);
      yield* SubscriptionRef.set(
        h.entries,
        new Map([
          [HUB, hub],
          [NODE, node],
          [
            addedId,
            {
              ...hub,
              target: new RelayConnectionTarget({ environmentId: addedId, label: "Added" }),
            },
          ],
        ]),
      );
      yield* Deferred.await(second);
      expect(attached.get(HUB)).toBe(1);
      expect(attached.get(addedId)).toBe(1);
      yield* Fiber.interrupt(work);
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { scopes: [] as readonly AuthEnvironmentScope[], capability: true, count: 0 },
    { scopes: [AuthHubProxyScope], capability: false, count: 0 },
    { scopes: [AuthHubProxyScope], capability: true, count: 1 },
  ])("requires both the session scope and hub capability (%j)", ({ scopes, capability, count }) =>
    Effect.gen(function* () {
      const h = yield* makeRegistry;
      const environment = yield* decodeDescriptor({
        environmentId: HUB,
        label: "Hub",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "1",
        capabilities: { hubProxy: capability },
      });
      yield* watchHubProxyDiscovery(
        Stream.make({
          hubEnvironmentId: HUB,
          hubConnectionId: "primary",
          hubLabel: "Hub",
          nodes: [{ nodeId: "new", environmentId: EnvironmentId.make("new"), label: "New" }],
          sessionScopes: scopes,
          config: { environment },
        }),
      ).pipe(Effect.provideService(EnvironmentRegistry, h.registry));
      expect(h.registered).toHaveLength(count);
    }),
  );

  it.effect(
    "retains offline hubs and initial missing primary hubs, but removes routes after a hub leaves the registry",
    () =>
      Effect.gen(function* () {
        const h = yield* makeRegistry;
        yield* watchRemovedHubProxyRoutes(Stream.make(new Map([[NODE, node]]))).pipe(
          Effect.provideService(EnvironmentRegistry, h.registry),
        );
        expect(yield* Deferred.isDone(h.removed)).toBe(false);
        yield* watchRemovedHubProxyRoutes(
          Stream.make(
            new Map([
              [HUB, hub],
              [NODE, node],
            ]),
            new Map([
              [HUB, { ...hub, enabled: false }],
              [NODE, node],
            ]),
          ),
        ).pipe(Effect.provideService(EnvironmentRegistry, h.registry));
        expect(yield* Deferred.isDone(h.removed)).toBe(false);
        yield* watchRemovedHubProxyRoutes(
          Stream.make(
            new Map([
              [HUB, hub],
              [NODE, node],
            ]),
            new Map([[NODE, node]]),
          ),
        ).pipe(Effect.provideService(EnvironmentRegistry, h.registry));
        expect(yield* Deferred.await(h.removed)).toBe("hub:hub:node");
      }),
  );
});
