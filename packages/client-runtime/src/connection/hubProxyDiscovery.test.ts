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
  BearerConnectionCredential,
  BearerConnectionProfile,
  HubProxyConnectionProfile,
  type ConnectionCatalogEntry,
  type ConnectionRegistration,
} from "./catalog.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  HubProxyConnectionTarget,
  PrimaryConnectionTarget,
  RelayConnectionTarget,
} from "./model.ts";
import { EnvironmentRegistry } from "./registry.ts";
import { ConnectionCredentialStore } from "./credentialStore.ts";
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
  const registrations: ConnectionRegistration[] = [];
  // Only the coordinator's registry boundary is faked; route decisions and lifecycle streams run normally.
  const registry = EnvironmentRegistry.of({
    entries,
    state: () => Effect.succeed({ ...AVAILABLE_CONNECTION_STATE, phase: "connected" }),
    register: (registration: ConnectionRegistration) =>
      Effect.sync(() => {
        registered.push(registration.target.environmentId);
        registrations.push(registration);
        return true;
      }),
    removeRoute: (_id: EnvironmentId, routeId: string) =>
      Deferred.succeed(removed, routeId).pipe(Effect.asVoid),
  } as unknown as EnvironmentRegistry["Service"]);
  return { registry, entries, removed, registered, registrations };
});

it.effect("keeps known hub nodes on the reachable route when its session lacks hub access", () =>
  Effect.gen(function* () {
    const h = yield* makeRegistry;
    yield* watchHubProxyDiscovery(
      Stream.succeed({
        hubEnvironmentId: HUB,
        hubConnectionId: "another-route",
        hubLabel: "Hub",
        nodes: [],
        sessionScopes: [],
        config: { environment: { capabilities: { hubProxy: true } } } as ServerConfig,
      }),
    ).pipe(Effect.provideService(EnvironmentRegistry, h.registry));
    expect(yield* Deferred.isDone(h.removed)).toBe(false);
    expect(h.registrations).toHaveLength(1);
    expect(h.registrations[0]?._tag).toBe("HubProxyConnectionRegistration");
    const registration = h.registrations[0];
    if (registration?._tag !== "HubProxyConnectionRegistration")
      throw new Error("Expected hub route");
    expect(registration.profile.hubConnectionId).toBe("another-route");
  }),
);

const makeConnectedDiscovery = Effect.fn(function* (options: {
  readonly failReads?: number;
  readonly failSubscriptions?: number;
  readonly scopes?: readonly AuthEnvironmentScope[];
  readonly subscriptionError?: HubNodesError;
  readonly capability?: boolean;
  readonly missingMethod?: boolean;
  readonly bearerAddress?: string;
}) {
  const h = yield* makeRegistry;
  const firstRead = yield* Deferred.make<void>();
  const subscribed = yield* Deferred.make<void>();
  const reconciled = yield* Deferred.make<void>();
  let reads = 0;
  let subscriptions = 0;
  const primary = new PrimaryConnectionTarget({
    environmentId: HUB,
    label: "Hub",
    httpBaseUrl: "https://hub.test",
    wsBaseUrl: "wss://hub.test",
  });
  const target = options.bearerAddress === undefined ? primary : new BearerConnectionTarget({
    environmentId: HUB, label: "Hub", connectionId: "a",
  });
  const aUrl = options.bearerAddress ?? primary.httpBaseUrl;
  const bearerRoute = (id: string, url: string) => ({
    target: new BearerConnectionTarget({ environmentId: HUB, label: "Hub", connectionId: id }),
    profile: Option.some(new BearerConnectionProfile({ connectionId: id, environmentId: HUB, label: "Hub", httpBaseUrl: url, wsBaseUrl: url.replace(/^http/, "ws") })),
  });
  const stored = new Map([["a", new BearerConnectionCredential({ token: "weak" })], ["b", new BearerConnectionCredential({ token: "strong" })]]);
  const requests: string[] = [];
  const reconnected = yield* Deferred.make<void>();
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
    inboundFrames: Effect.succeed(0),
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
        httpBaseUrl: aUrl,
        socketUrl: aUrl.replace(/^http/, "ws"),
        httpAuthorization: options.bearerAddress === undefined ? null : { _tag: "Bearer", token: "weak" },
      }),
    ),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
    reconnect: Deferred.succeed(reconnected, undefined).pipe(Effect.asVoid),
  });
  const registry = EnvironmentRegistry.of({
    ...h.registry,
    entries: yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
      new Map([[HUB, options.bearerAddress === undefined ? { ...hub, target } : { ...bearerRoute("a", aUrl), enabled: true, alternateRoutes: [bearerRoute("b", "https://hub.test/")] }]]),
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
      const header = request.headers.authorization ?? "";
      requests.push(header);
      return HttpClientResponse.fromWeb(
        request,
        reads <= (options.failReads ?? 0)
          ? new Response("unavailable", { status: 503 })
          : Response.json(header === "Bearer strong" ? { ...auth, scopes: [AuthHubProxyScope] } : auth),
      );
    }),
  );
  const work = yield* watchConnectedHubProxyDiscovery.pipe(
    Effect.provideService(EnvironmentRegistry, registry),
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.provideService(ConnectionCredentialStore, ConnectionCredentialStore.of({
      get: (id) => Effect.sync(() => Option.fromUndefinedOr(stored.get(id))),
      put: (id, credential, expected) => Effect.sync(() => { if (expected === undefined || (stored.get(id)?.token ?? null) === expected) stored.set(id, credential); }),
      remove: (id) => Effect.sync(() => { stored.delete(id); }),
    })),
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
    stored, requests, reconnected,
  };
});

it.effect("converges a stronger saved hub credential over the active tailnet address", () =>
  Effect.gen(function* () {
    const h = yield* makeConnectedDiscovery({ scopes: [], bearerAddress: "http://100.100.1.1:3773/" });
    yield* Deferred.await(h.reconciled);
    expect(h.stored.get("a")?.token).toBe("strong");
    expect(yield* Deferred.isDone(h.reconnected)).toBe(true);
    expect(h.requests).toContain("Bearer strong");
  }).pipe(Effect.scoped),
);

it.effect("does not send an HTTPS paired credential over a plain LAN address", () =>
  Effect.gen(function* () {
    const h = yield* makeConnectedDiscovery({ scopes: [], bearerAddress: "http://192.168.1.5:3773/" });
    yield* Deferred.await(h.reconciled);
    expect(h.stored.get("a")?.token).toBe("weak");
    expect(h.requests).not.toContain("Bearer strong");
    expect(yield* Deferred.isDone(h.reconnected)).toBe(false);
  }).pipe(Effect.scoped),
);

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
        inboundFrames: Effect.succeed(0),
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
    { scopes: [] as readonly AuthEnvironmentScope[], capability: true, registered: [NODE] },
    { scopes: [AuthHubProxyScope], capability: false, registered: [] },
    { scopes: [AuthHubProxyScope], capability: true, registered: [EnvironmentId.make("new")] },
  ])(
    "requires both the session scope and hub capability (%j)",
    ({ scopes, capability, registered }) =>
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
        expect(h.registered).toEqual(registered);
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

it.effect("definitive permission loss removes only routes owned by that hub connection", () =>
  Effect.gen(function* () {
    const h = yield* makeRegistry;
    const update = {
      hubEnvironmentId: HUB,
      hubConnectionId: "another-route",
      hubLabel: "Hub",
      nodes: [],
      sessionScopes: [],
    };
    yield* watchHubProxyDiscovery(Stream.succeed(update)).pipe(
      Effect.provideService(EnvironmentRegistry, h.registry),
    );
    expect(yield* Deferred.isDone(h.removed)).toBe(false);
    yield* watchHubProxyDiscovery(Stream.succeed({ ...update, hubConnectionId: "primary" })).pipe(
      Effect.provideService(EnvironmentRegistry, h.registry),
    );
    expect(yield* Deferred.isDone(h.removed)).toBe(true);
    expect(yield* Deferred.await(h.removed)).toBe("hub:hub:node");
  }),
);
