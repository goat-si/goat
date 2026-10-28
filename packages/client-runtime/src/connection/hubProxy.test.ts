import { openHubProxySocket } from "./hubProxySocket.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { EnvironmentId, ExecutionEnvironmentDescriptor, hubProxyNodePath } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  BearerConnectionCredential,
  BearerConnectionProfile,
  BearerConnectionRegistration,
  HubProxyConnectionProfile,
  HubProxyConnectionRegistration,
  type ConnectionCatalogEntry,
} from "./catalog.ts";
import {
  BearerConnectionTarget,
  HubProxyConnectionTarget,
  RelayConnectionTarget,
  SshConnectionTarget,
  hubProxyConnectionId,
} from "./model.ts";
import {
  connectionRouteId,
  connectionRouteLabel,
  connectionRouteKind,
  insertRoute,
  mergeLearnedRoutes,
  routeHttpBaseUrl,
} from "./routes.ts";
import { environmentMcpUrl } from "./presentation.ts";
import { reconcileHubProxyRoutes } from "./hubProxyDiscovery.ts";
import { hubProxyNodeUnavailable, hubProxyRefusal, requestHubProxyJson } from "./hubProxyHttp.ts";
import { make as makeAuth } from "./hubProxyAuthSource.ts";
import { ConnectionProfileStore } from "./profileStore.ts";
import { ConnectionCredentialStore } from "./credentialStore.ts";
import { PrimaryConnectionEndpoint } from "../platform/capabilities.ts";
import {
  EMPTY_CONNECTION_CATALOG_DOCUMENT,
  decodeConnectionCatalogStorage,
  encodeConnectionCatalogStorage,
  registerConnectionInCatalog,
  removeConnectionFromCatalog,
} from "../platform/storageDocument.ts";
import { resolveAssetUrl } from "../state/assets.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { makeEnvironmentHttpApiGroupClient, layerRemoteHttpClient } from "../rpc/http.ts";
import { resolveRemoteWebSocketConnectionUrl } from "../authorization/remote.ts";

const HUB = EnvironmentId.make("hub");
const NODE = EnvironmentId.make("node");
const NODE_ID = "node/한글:one";
const ID = hubProxyConnectionId(HUB, NODE_ID);
const profile = new HubProxyConnectionProfile({
  connectionId: ID,
  environmentId: NODE,
  label: "Node",
  hubEnvironmentId: HUB,
  hubConnectionId: "hub-address",
  nodeId: NODE_ID,
  hubLabel: "My hub",
});
const target = new HubProxyConnectionTarget({
  connectionId: ID,
  environmentId: NODE,
  label: "Node",
});
const registration = new HubProxyConnectionRegistration({ target, profile });
const entry: ConnectionCatalogEntry = { target, profile: Option.some(profile), enabled: false };
const bearerProfile = new BearerConnectionProfile({
  connectionId: "hub-address",
  environmentId: HUB,
  label: "My hub",
  httpBaseUrl: "https://hub.test/base/",
  wsBaseUrl: "wss://hub.test/base/",
});
const bearerTarget = new BearerConnectionTarget({
  connectionId: bearerProfile.connectionId,
  environmentId: HUB,
  label: "My hub",
});
const descriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor)({
  environmentId: NODE,
  label: "Node",
  platform: { os: "linux", arch: "x64" },
  serverVersion: "1.0.0",
  capabilities: {},
});

const authStores = {
  profile: ConnectionProfileStore.of({
    get: () => Effect.succeedSome(bearerProfile),
    put: () => Effect.void,
    remove: () => Effect.void,
  }),
  credential: ConnectionCredentialStore.of({
    get: () => Effect.succeedSome(new BearerConnectionCredential({ token: "hub-token" })),
    put: () => Effect.void,
    remove: () => Effect.void,
  }),
};
const withStores = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.provideService(ConnectionProfileStore, authStores.profile),
    Effect.provideService(ConnectionCredentialStore, authStores.credential),
  );

it.effect.each([".well-known/goat/environment", "snapshot", "api/orchestration/shell"])(
  "JSON %s signs the outgoing deployment prefix before and after rejected-token renewal",
  (route) =>
    Effect.gen(function* () {
      const urls: string[] = [];
      const proofs: Array<{ method: string; url: string; accessToken?: string }> = [];
      const rejectedTokens: Array<string | undefined> = [];
      const signer = ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("key"),
        createProof: (input) =>
          Effect.sync(() => {
            proofs.push(input);
            return "proof";
          }),
      });
      const current = (rejected?: string) =>
        Effect.sync(() => {
          rejectedTokens.push(rejected);
          return {
            httpBaseUrl:
              rejected === undefined ? "https://hub.test/base/" : "https://fresh.test/deployed/",
            authorization: {
              _tag: "Dpop" as const,
              accessToken: rejected === undefined ? "old-token" : "new-token",
              expiresAtEpochMs: 3600000,
            },
            signer,
          };
        });
      const auth = {
        httpBaseUrl: "https://hub.test/base/",
        authorization: {
          _tag: "Dpop" as const,
          accessToken: "old-token",
          expiresAtEpochMs: 3600000,
        },
        signer,
        current,
      };
      const fetchFn: typeof fetch = async (url) => {
        urls.push(String(url));
        return urls.length === 1
          ? Response.json({}, { status: 401 })
          : Response.json({ value: "node" });
      };
      const result = yield* requestHubProxyJson(auth, NODE_ID, `/${route}`, (value) =>
        Effect.succeed(value),
      ).pipe(Effect.provide(layerRemoteHttpClient(fetchFn)));
      expect(result).toEqual({ value: "node" });
      expect(urls).toEqual([
        `https://hub.test/base${hubProxyNodePath(NODE_ID)}/${route}`,
        `https://fresh.test/deployed${hubProxyNodePath(NODE_ID)}/${route}`,
      ]);
      expect(proofs).toEqual(
        urls.map((url, index) => ({
          method: "GET",
          url,
          accessToken: index === 0 ? "old-token" : "new-token",
        })),
      );
      expect(rejectedTokens).toEqual([undefined, "old-token"]);
    }),
);

describe("hub proxy routes", () => {
  it("encodes node ids, ranks after SSH and before relay, and never learns or advertises MCP", () => {
    expect(ID).toBe(`hub:hub:${encodeURIComponent(NODE_ID)}`);
    const route = { target, profile: Option.some(profile) };
    expect(connectionRouteId(target)).toBe(ID);
    expect(connectionRouteKind(route)).toBe("hub-proxy");
    expect(connectionRouteLabel(route)).toBe("via My hub");
    expect(routeHttpBaseUrl(route)).toBeNull();
    const ssh = {
      target: new SshConnectionTarget({ environmentId: NODE, label: "Node", connectionId: "ssh" }),
      profile: Option.none(),
    };
    const relay = {
      target: new RelayConnectionTarget({ environmentId: NODE, label: "Node" }),
      profile: Option.none(),
    };
    expect(insertRoute([ssh, relay], route).map((r) => connectionRouteId(r.target))).toEqual([
      "ssh",
      ID,
      "relay",
    ]);
    expect(
      mergeLearnedRoutes({
        entry,
        activeRoute: route,
        reported: [{ httpBaseUrl: "https://node.test" }],
        allowInsecure: false,
      }),
    ).toBeNull();
    expect(environmentMcpUrl({ entry, connectedTarget: target })).toBeNull();
  });

  it.effect(
    "persists a profile-only registration without exposing unknown tags to older readers or removing the hub credential",
    () =>
      Effect.gen(function* () {
        const hub = new BearerConnectionRegistration({
          target: bearerTarget,
          profile: bearerProfile,
          credential: new BearerConnectionCredential({ token: "hub-token" }),
        });
        const saved = registerConnectionInCatalog(
          registerConnectionInCatalog(EMPTY_CONNECTION_CATALOG_DOCUMENT, hub),
          registration,
        );
        expect(saved.credentials).toHaveLength(1);
        const encoded = yield* encodeConnectionCatalogStorage(saved);
        const legacy = Schema.Struct({
          schemaVersion: Schema.Literal(1),
          targets: Schema.Array(BearerConnectionTarget),
          profiles: Schema.Array(BearerConnectionProfile),
          credentials: Schema.Array(
            Schema.Struct({ connectionId: Schema.String, credential: BearerConnectionCredential }),
          ),
        });
        expect(
          (yield* Schema.decodeUnknownEffect(Schema.fromJsonString(legacy))(encoded)).credentials,
        ).toHaveLength(1);
        const restored = yield* decodeConnectionCatalogStorage(encoded);
        expect(restored.targets).toEqual(saved.targets);
        expect(restored.profiles).toEqual(saved.profiles);
        const removed = removeConnectionFromCatalog(restored, NODE);
        expect(removed.credentials).toEqual(saved.credentials);
        expect(removed.profiles).toEqual([bearerProfile]);
      }),
  );

  it("reconciles equal metadata without registrations and rewrites the hub route without changing saved order or enabled state", () => {
    const input = {
      hubEnvironmentId: HUB,
      hubConnectionId: "hub-address",
      hubLabel: "My hub",
      nodes: [
        { nodeId: NODE_ID, environmentId: NODE, label: "Node" },
        { nodeId: "unknown", environmentId: null, label: "Unknown" },
        { nodeId: "self", environmentId: HUB, label: "Hub" },
      ],
      existing: [entry],
    };
    expect(reconcileHubProxyRoutes(input)).toEqual({ register: [], remove: [] });
    const updated = reconcileHubProxyRoutes({ ...input, hubConnectionId: "primary" });
    expect(updated.register).toHaveLength(1);
    expect(updated.register[0]?.profile.hubConnectionId).toBe("primary");
    expect(entry.enabled).toBe(false);
    expect(reconcileHubProxyRoutes({ ...input, nodes: [] })).toEqual({
      register: [],
      remove: [ID],
    });
    expect(
      reconcileHubProxyRoutes({
        ...input,
        nodes: [
          {
            nodeId: NODE_ID,
            environmentId: EnvironmentId.make("replacement"),
            label: "Replacement",
          },
        ],
      }).remove,
    ).toEqual([ID]);
  });
});

describe("HubProxyAuthSource", () => {
  it.effect("resolves the hub credential for a learned route using its credential owner", () =>
    Effect.gen(function* () {
      let requested = "";
      const source = yield* makeAuth.pipe(
        Effect.provideService(ConnectionProfileStore, authStores.profile),
        Effect.provideService(ConnectionCredentialStore, {
          ...authStores.credential,
          get: (id) => {
            requested = id;
            return Effect.succeedSome(new BearerConnectionCredential({ token: "hub-token" }));
          },
        }),
      );
      expect(
        yield* source.resolve(
          new HubProxyConnectionProfile({
            ...profile,
            hubConnectionId: "learned:hub:https://hub.test@hub-address",
          }),
        ),
      ).toEqual({
        httpBaseUrl: bearerProfile.httpBaseUrl,
        authorization: { _tag: "Bearer", token: "hub-token" },
      });
      expect(requested).toBe("hub-address");
    }),
  );

  it.effect(
    "uses an optional primary endpoint with cookie authentication and blocks mobile primary routes",
    () =>
      Effect.gen(function* () {
        const primary = new HubProxyConnectionProfile({ ...profile, hubConnectionId: "primary" });
        const source = yield* withStores(makeAuth).pipe(
          Effect.provideService(PrimaryConnectionEndpoint, {
            endpoint: Effect.succeed({
              httpBaseUrl: "https://primary.test",
              bearerToken: Option.none(),
            }),
          }),
        );
        expect(yield* source.resolve(primary)).toEqual({
          httpBaseUrl: "https://primary.test",
          authorization: null,
        });
        const mobile = yield* withStores(makeAuth);
        expect(yield* Effect.flip(mobile.resolve(primary))).toMatchObject({
          _tag: "ConnectionBlockedError",
          reason: "configuration",
        });
      }),
  );

  it.effect("blocks absent profiles and credentials before making requests", () =>
    Effect.gen(function* () {
      const missingProfile = yield* makeAuth.pipe(
        Effect.provideService(ConnectionProfileStore, {
          ...authStores.profile,
          get: () => Effect.succeedNone,
        }),
        Effect.provideService(ConnectionCredentialStore, authStores.credential),
      );
      expect(yield* Effect.flip(missingProfile.resolve(profile))).toMatchObject({
        reason: "configuration",
      });
      const missingCredential = yield* makeAuth.pipe(
        Effect.provideService(ConnectionProfileStore, authStores.profile),
        Effect.provideService(ConnectionCredentialStore, {
          ...authStores.credential,
          get: () => Effect.succeedNone,
        }),
      );
      expect(yield* Effect.flip(missingCredential.resolve(profile))).toMatchObject({
        reason: "authentication",
      });
    }),
  );
});

describe("prefix-preserving client URLs", () => {
  it.effect.each(["https://hub.test", `https://hub.test${hubProxyNodePath(NODE_ID)}`])(
    "keeps descriptor, ticket, socket and asset requests below %s",
    (base) =>
      Effect.gen(function* () {
        const normalized = `${base}/`;
        expect(environmentEndpointUrl(base, "/api/auth/session")).toBe(
          `${normalized}api/auth/session`,
        );
        expect(resolveAssetUrl(base, "/api/assets/token/file.png")).toBe(
          `${normalized}api/assets/token/file.png`,
        );
        const calls: string[] = [];
        const fetchFn = ((url) => {
          calls.push(String(url));
          return Promise.resolve(
            String(url).includes("websocket-ticket")
              ? Response.json({ ticket: "ticket", expiresAt: "2026-10-20T00:00:00.000Z" })
              : Response.json(descriptor),
          );
        }) satisfies typeof fetch;
        const result = yield* Effect.gen(function* () {
          const client = yield* makeEnvironmentHttpApiGroupClient(base, "metadata");
          yield* client.descriptor();
          return yield* resolveRemoteWebSocketConnectionUrl({
            httpBaseUrl: base,
            wsBaseUrl: base.replace("https:", "wss:"),
            bearerToken: "hub-token",
          });
        }).pipe(Effect.provide(layerRemoteHttpClient(fetchFn)));
        expect(calls).toEqual([
          `${normalized}.well-known/goat/environment`,
          `${normalized}api/auth/websocket-ticket/rpc`,
        ]);
        expect(new URL(result).pathname).toBe(`${new URL(base).pathname.replace(/\/$/, "")}/ws`);
      }),
  );

  it("sends a direct target with a leftover path to its origin root", () => {
    const base = "https://environment.test/pair";
    expect(environmentEndpointUrl(base, "/api/auth/session")).toBe(
      "https://environment.test/api/auth/session",
    );
    expect(resolveAssetUrl(base, "/api/assets/token/file.png")).toBe(
      "https://environment.test/api/assets/token/file.png",
    );
  });
});

describe("hubProxyRefusal", () => {
  it("tells apart an ended node enrollment, a pairing without hub access, and other refusals", () => {
    expect(hubProxyRefusal({ code: "hub_node_enrollment_required" }).detail).toContain(
      "Allow phone access again",
    );
    expect(
      hubProxyRefusal({ code: "insufficient_scope", requiredScope: "hub:proxy" }).detail,
    ).toContain("goat pair --hub-proxy");
    expect(hubProxyRefusal(null).detail).toBe(
      "The hub session does not permit access to this node.",
    );
    expect(hubProxyRefusal({ code: "x", message: "Node said no." }).reason).toBe("permission");
  });
});

describe("hubProxyNodeUnavailable", () => {
  it("retries a node the hub cannot reach quietly, keeping the hub's reason", () => {
    expect(
      hubProxyNodeUnavailable({ code: "hub_node_unavailable", message: "mini is unavailable" }),
    ).toMatchObject({
      reason: "host-unreachable",
      detail: "The hub cannot reach this machine: mini is unavailable",
    });
    // Any other 503 is not the hub speaking about its node.
    expect(hubProxyNodeUnavailable({ message: "busy" })).toBeUndefined();
    expect(hubProxyNodeUnavailable(null)).toBeUndefined();
  });
});

it.effect(
  "Connect proxy authorization belongs to the hub and keeps a verified direct address",
  () =>
    Effect.gen(function* () {
      const calls: Array<
        Parameters<RemoteEnvironmentAuthorization["Service"]["authorizeDpopHttp"]>[0]
      > = [];
      const remote = RemoteEnvironmentAuthorization.of({
        authorizeBearer: () => Effect.die("unexpected bearer"),
        authorizeDpop: () => Effect.die("unexpected socket"),
        authorizeDpopHttp: (input) =>
          Effect.sync(() => {
            calls.push(input);
            return {
              environmentId: HUB,
              label: "Hub",
              httpBaseUrl: input.directEndpoint?.httpBaseUrl ?? "https://managed.test/prefix/",
              httpAuthorization: {
                _tag: "Dpop" as const,
                accessToken: "hub-token",
                expiresAtEpochMs: 3600000,
              },
            };
          }),
      });
      const signer = ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("key"),
        createProof: () => Effect.succeed("proof"),
      });
      const source = yield* makeAuth.pipe(
        Effect.provideService(ConnectionProfileStore, {
          ...authStores.profile,
          get: () =>
            Effect.succeedSome(
              new BearerConnectionProfile({ ...bearerProfile, authorization: "t3-connect" }),
            ),
        }),
        Effect.provideService(ConnectionCredentialStore, {
          ...authStores.credential,
          get: () => Effect.die("Connect tokens must not enter the node credential store"),
        }),
        Effect.provideService(RemoteEnvironmentAuthorization, remote),
        Effect.provideService(ManagedRelayDpopSigner, signer),
      );
      const direct = yield* source.resolve(profile);
      expect(direct.httpBaseUrl).toBe(bearerProfile.httpBaseUrl);
      expect(calls[0]).toEqual({
        expectedEnvironmentId: HUB,
        directEndpoint: { httpBaseUrl: bearerProfile.httpBaseUrl },
      });
      expect(direct.authorization).toMatchObject({
        _tag: "Dpop",
        hubProxyOwner: { environmentId: HUB, nodeId: NODE_ID, endpointMode: "direct" },
      });
      const relay = yield* source.resolve(
        new HubProxyConnectionProfile({ ...profile, hubConnectionId: "relay" }),
      );
      expect(calls[1]).toEqual({ expectedEnvironmentId: HUB });
      expect(relay.httpBaseUrl).toBe("https://managed.test/prefix/");
    }),
);

it.effect(
  "Connect socket renewal signs the refreshed node prefix and binds the upgrade proof to its RPC ticket",
  () =>
    Effect.gen(function* () {
      const calls: string[] = [];
      const proofs: Array<{ method: string; url: string; accessToken?: string }> = [];
      const signer = ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed("key"),
        createProof: (input) =>
          Effect.sync(() => {
            proofs.push(input);
            return "proof";
          }),
      });
      const current = (rejected?: string) =>
        Effect.succeed({
          httpBaseUrl:
            rejected === undefined ? "https://hub.test/base/" : "https://fresh.test/deployed/",
          authorization: {
            _tag: "Dpop" as const,
            accessToken: rejected === undefined ? "old-token" : "new-token",
            expiresAtEpochMs: 3600000,
          },
          signer,
        });
      const auth = { ...(yield* current()), current };
      const fetchFn: typeof fetch = async (url) => {
        calls.push(String(url));
        return calls.length === 1
          ? Response.json(
              {
                _tag: "EnvironmentAuthInvalidError",
                code: "auth_invalid",
                reason: "invalid_credential",
                traceId: "test",
              },
              { status: 401 },
            )
          : Response.json({ ticket: "bound-ticket", expiresAt: "2026-10-28T00:00:00.000Z" });
      };
      const socket = yield* openHubProxySocket(auth, NODE_ID, {
        label: "GOAT Test",
        deviceType: "mobile",
      }).pipe(Effect.provide(layerRemoteHttpClient(fetchFn)));
      expect(calls).toEqual([
        `https://hub.test/base${hubProxyNodePath(NODE_ID)}/api/auth/websocket-ticket/rpc`,
        `https://fresh.test/deployed${hubProxyNodePath(NODE_ID)}/api/auth/websocket-ticket/rpc`,
      ]);
      expect(proofs.map((proof) => proof.accessToken)).toEqual([
        "old-token",
        "new-token",
        "bound-ticket",
      ]);
      expect(proofs.at(-1)?.url).toBe(`https://fresh.test/deployed${hubProxyNodePath(NODE_ID)}/ws`);
      expect(socket.socketUrl).toContain("wsTicket=bound-ticket");
      expect(socket.httpBaseUrl).toBe(`https://fresh.test/deployed${hubProxyNodePath(NODE_ID)}/`);
    }),
);
