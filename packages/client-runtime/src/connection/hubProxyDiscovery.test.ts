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
  ConnectionBlockedError,
  ConnectionTransientError,
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

it.effect("leaves hub device routes alone when the hub session lacks hub access", () =>
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
    expect(h.registrations).toEqual([]);
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
  readonly bearerOverTailscale?: boolean;
  /** Makes the active route a Tailscale route learned through route "a" at this LAN address. */
  readonly learnedFromLan?: string;
  /** Session reads with the hub-access token that fail before one answers. */
  readonly failStrongReads?: number;
  /** Runs when the hub-access token is checked, before the hub answers. */
  readonly onStrongRead?: (stored: Map<string, BearerConnectionCredential>) => void;
  /** Adds a device reached through the hub whose last attempt was refused. */
  readonly blockedDevice?: boolean;
  /** Credential reads and writes that fail before the store answers again. */
  readonly failStoreReads?: number;
  readonly failStoreWrites?: number;
}) {
  const h = yield* makeRegistry;
  const firstRead = yield* Deferred.make<void>();
  const subscribed = yield* Deferred.make<void>();
  const reconciled = yield* Deferred.make<void>();
  const strongRead = yield* Deferred.make<void>();
  const emitted = yield* Deferred.make<void>();
  const reconnected = yield* Deferred.make<void>();
  const deviceRetried = yield* Deferred.make<void>();
  const storeFailed = yield* Deferred.make<void>();
  let storeReads = 0;
  let storeWrites = 0;
  const retried: EnvironmentId[] = [];
  let reads = 0;
  let strongReads = 0;
  let subscriptions = 0;
  const primary = new PrimaryConnectionTarget({
    environmentId: HUB,
    label: "Hub",
    httpBaseUrl: "https://hub.test",
    wsBaseUrl: "wss://hub.test",
  });
  // A bearer hub has route "a" holding a session without hub:proxy and route "b" holding one with it.
  const activeId =
    options.learnedFromLan === undefined || options.bearerAddress === undefined
      ? "a"
      : `learned:hub:${new URL(options.bearerAddress).origin}@a`;
  const target =
    options.bearerAddress === undefined
      ? primary
      : new BearerConnectionTarget({ environmentId: HUB, label: "Hub", connectionId: activeId });
  const aUrl = options.bearerAddress ?? primary.httpBaseUrl;
  const bearerRoute = (id: string, url: string, tailscale = false, learned = false) => ({
    target: new BearerConnectionTarget({ environmentId: HUB, label: "Hub", connectionId: id }),
    profile: Option.some(
      new BearerConnectionProfile({
        connectionId: id,
        environmentId: HUB,
        label: "Hub",
        httpBaseUrl: url,
        wsBaseUrl: url.replace(/^http/, "ws"),
        ...(tailscale ? { network: "tailscale" as const } : {}),
        ...(learned ? { learned: true } : {}),
      }),
    ),
  });
  const stored = new Map([
    ["a", new BearerConnectionCredential({ token: "weak" })],
    ["b", new BearerConnectionCredential({ token: "strong" })],
  ]);
  const requests: string[] = [];
  const environment = yield* decodeDescriptor({
    environmentId: HUB,
    label: "Hub",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "1",
    capabilities: { hubProxy: options.capability ?? true },
  });
  const snapshot: HubNodesSnapshot = {
    hubEnvironmentId: HUB,
    nodes: options.blockedDevice
      ? [
          {
            nodeId: "node",
            environmentId: NODE,
            label: "Node",
            kind: "linked",
            routes: [],
            status: "online",
            lastSeenAt: null,
            addedBy: null,
          },
        ]
      : [],
    notices: [],
  };
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
        httpAuthorization:
          options.bearerAddress === undefined ? null : { _tag: "Bearer", token: "weak" },
      }),
    ),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map([
      ...(options.blockedDevice ? [[NODE, { ...node, enabled: true }] as const] : []),
      [
        HUB,
        options.bearerAddress === undefined
          ? { ...hub, target }
          : options.learnedFromLan === undefined
            ? {
                ...bearerRoute("a", aUrl, options.bearerOverTailscale),
                enabled: true,
                alternateRoutes: [bearerRoute("b", "https://hub.test/")],
              }
            : {
                ...bearerRoute(activeId, aUrl, true, true),
                enabled: true,
                alternateRoutes: [
                  bearerRoute("a", options.learnedFromLan),
                  bearerRoute("b", "https://hub.test/"),
                ],
              },
      ],
    ]),
  );
  const registry = EnvironmentRegistry.of({
    ...h.registry,
    entries,
    state: (id: EnvironmentId) =>
      Deferred.succeed(reconciled, undefined).pipe(
        Effect.as(
          id === NODE
            ? {
                ...AVAILABLE_CONNECTION_STATE,
                phase: "blocked" as const,
                lastFailure: new ConnectionBlockedError({ reason: "permission", detail: "No" }),
              }
            : { ...AVAILABLE_CONNECTION_STATE, phase: "connected" as const },
        ),
      ),
    retryNow: (id: EnvironmentId) =>
      Effect.sync(() => {
        retried.push(id);
      }).pipe(Effect.andThen(Deferred.succeed(deviceRetried, undefined))),
    reconnect: (id: EnvironmentId) =>
      id === HUB ? Deferred.succeed(reconnected, undefined).pipe(Effect.asVoid) : Effect.void,
    followStream: (
      id: EnvironmentId,
      stream: Stream.Stream<unknown, unknown, EnvironmentSupervisor>,
    ) =>
      id !== HUB
        ? Stream.empty
        : stream.pipe(
            Stream.provideService(EnvironmentSupervisor, supervisor),
            Stream.tap(() => Deferred.succeed(emitted, undefined)),
          ),
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
      if (header === "Bearer strong") {
        strongReads++;
        options.onStrongRead?.(stored);
        yield* Deferred.succeed(strongRead, undefined);
      }
      return HttpClientResponse.fromWeb(
        request,
        reads <= (options.failReads ?? 0) ||
          (header === "Bearer strong" && strongReads <= (options.failStrongReads ?? 0))
          ? new Response("unavailable", { status: 503 })
          : Response.json(
              header === "Bearer strong" ? { ...auth, scopes: [AuthHubProxyScope] } : auth,
            ),
      );
    }),
  );
  const work = yield* watchConnectedHubProxyDiscovery.pipe(
    Effect.provideService(EnvironmentRegistry, registry),
    Effect.provideService(HttpClient.HttpClient, httpClient),
    Effect.provideService(
      ConnectionCredentialStore,
      ConnectionCredentialStore.of({
        get: (id) =>
          ++storeReads <= (options.failStoreReads ?? 0)
            ? Deferred.succeed(storeFailed, undefined).pipe(
                Effect.andThen(
                  Effect.fail(new ConnectionTransientError({ reason: "network", detail: "Busy" })),
                ),
              )
            : Effect.sync(() => Option.fromUndefinedOr(stored.get(id))),
        put: (id, credential, expected) =>
          ++storeWrites <= (options.failStoreWrites ?? 0)
            ? Deferred.succeed(storeFailed, undefined).pipe(
                Effect.andThen(
                  Effect.fail(new ConnectionTransientError({ reason: "network", detail: "Busy" })),
                ),
              )
            : Effect.sync(() => {
                if (expected === undefined || (stored.get(id)?.token ?? null) === expected)
                  stored.set(id, credential);
              }),
        remove: (id) =>
          Effect.sync(() => {
            stored.delete(id);
          }),
      }),
    ),
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
    stored,
    requests,
    strongRead,
    emitted,
    reconnected,
    retried,
    deviceRetried,
    storeFailed,
  };
});

describe("a hub reached with a session that lacks hub:proxy", () => {
  it.effect("reconnects the hub with the saved pairing that has hub access", () =>
    Effect.gen(function* () {
      const h = yield* makeConnectedDiscovery({
        scopes: [],
        bearerAddress: "http://100.100.1.1:3773/",
        bearerOverTailscale: true,
      });
      yield* Deferred.await(h.reconnected);
      expect(h.stored.get("a")?.token).toBe("strong");
    }).pipe(Effect.scoped),
  );

  it.effect.each([{ failStoreReads: 1 }, { failStoreWrites: 1 }])(
    "retries after the credential store failed for a moment (%j)",
    (failure) =>
      Effect.gen(function* () {
        const h = yield* makeConnectedDiscovery({
          scopes: [],
          bearerAddress: "http://100.100.1.1:3773/",
          bearerOverTailscale: true,
          ...failure,
        });
        yield* Deferred.await(h.storeFailed);
        yield* TestClock.adjust("1 second");
        yield* Deferred.await(h.reconnected);
        expect(h.stored.get("a")?.token).toBe("strong");
      }).pipe(Effect.scoped),
  );

  it.effect("retries a hub-access check that failed for a moment", () =>
    Effect.gen(function* () {
      const h = yield* makeConnectedDiscovery({
        scopes: [],
        bearerAddress: "http://100.100.1.1:3773/",
        bearerOverTailscale: true,
        failStrongReads: 1,
      });
      yield* Deferred.await(h.strongRead);
      yield* TestClock.adjust("1 second");
      yield* Deferred.await(h.reconnected);
      expect(h.stored.get("a")?.token).toBe("strong");
    }).pipe(Effect.scoped),
  );

  it.effect("keeps a pairing saved while the hub-access check was running", () =>
    Effect.gen(function* () {
      const h = yield* makeConnectedDiscovery({
        scopes: [],
        bearerAddress: "http://100.100.1.1:3773/",
        bearerOverTailscale: true,
        onStrongRead: (stored) => {
          stored.set("a", new BearerConnectionCredential({ token: "fresh" }));
        },
      });
      yield* Deferred.await(h.emitted);
      expect(h.stored.get("a")?.token).toBe("fresh");
      expect(yield* Deferred.isDone(h.reconnected)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps an HTTPS-paired credential off a plain LAN address", () =>
    Effect.gen(function* () {
      const h = yield* makeConnectedDiscovery({
        scopes: [],
        bearerAddress: "http://192.168.1.5:3773/",
      });
      yield* Deferred.await(h.emitted);
      expect(h.requests).not.toContain("Bearer strong");
      expect(h.stored.get("a")?.token).toBe("weak");
      expect(yield* Deferred.isDone(h.reconnected)).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("keeps it off a LAN address that shares the active route's credential", () =>
    Effect.gen(function* () {
      const h = yield* makeConnectedDiscovery({
        scopes: [],
        bearerAddress: "http://100.100.1.1:3773/",
        learnedFromLan: "http://192.168.1.5:3773/",
      });
      yield* Deferred.await(h.emitted);
      expect(h.requests).not.toContain("Bearer strong");
      expect(h.stored.get("a")?.token).toBe("weak");
    }).pipe(Effect.scoped),
  );
});

describe("hub proxy discovery coordinator", () => {
  it.effect("retries a device refused through the hub when the hub confirms access", () =>
    Effect.gen(function* () {
      const h = yield* makeConnectedDiscovery({ blockedDevice: true });
      yield* Deferred.await(h.deviceRetried);
      expect(h.retried).toEqual([NODE]);
    }).pipe(Effect.scoped),
  );

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
        Effect.provideService(
          ConnectionCredentialStore,
          ConnectionCredentialStore.of({
            get: () => Effect.succeedNone,
            put: () => Effect.void,
            remove: () => Effect.void,
          }),
        ),
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
    { scopes: [] as readonly AuthEnvironmentScope[], capability: true, registered: [] },
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
