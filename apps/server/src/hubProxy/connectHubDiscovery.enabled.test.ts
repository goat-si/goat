// @effect-diagnostics-next-line nodeBuiltinImport:off -- sign real DPoP requests through production HTTP auth.
import * as NodeCrypto from "node:crypto";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  EnvironmentHttpApi,
  ExecutionEnvironmentDescriptor,
  WS_METHODS,
  type HubNodesSnapshot,
  type ServerConfig,
  type EnvironmentId,
} from "@goat/contracts";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  type DpopPublicJwk,
} from "@goat/shared/dpop";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Tracer from "effect/Tracer";
import { Etag, HttpPlatform, HttpRouter, HttpServerResponse } from "effect/http";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Settings from "../serverSettings.ts";
import * as AuthHttp from "../auth/http.ts";
import { authLayer, sshNode, startHub } from "./testFixtures.ts";
import * as Remote from "../../../../packages/client-runtime/src/authorization/service.ts";
import * as Tokens from "../../../../packages/client-runtime/src/authorization/tokenStore.ts";
import * as Managed from "../../../../packages/client-runtime/src/relay/managedRelay.ts";
import * as Capabilities from "../../../../packages/client-runtime/src/platform/capabilities.ts";
import * as Persistence from "../../../../packages/client-runtime/src/platform/persistence.ts";
import * as Registry from "../../../../packages/client-runtime/src/connection/registry.ts";
import * as Driver from "../../../../packages/client-runtime/src/connection/driver.ts";
import * as Connectivity from "../../../../packages/client-runtime/src/connection/connectivity.ts";
import * as Wakeups from "../../../../packages/client-runtime/src/connection/wakeups.ts";
import * as Profiles from "../../../../packages/client-runtime/src/connection/profileStore.ts";
import * as Credentials from "../../../../packages/client-runtime/src/connection/credentialStore.ts";
import * as HubAuth from "../../../../packages/client-runtime/src/connection/hubProxyAuthSource.ts";
import {
  BearerConnectionProfile,
  type ConnectionProfile,
} from "../../../../packages/client-runtime/src/connection/catalog.ts";
import {
  BearerConnectionTarget,
  RelayConnectionTarget,
} from "../../../../packages/client-runtime/src/connection/model.ts";
import { watchConnectedHubProxyDiscovery } from "../../../../packages/client-runtime/src/connection/hubProxyDiscovery.ts";
import { requestHubProxyJson } from "../../../../packages/client-runtime/src/connection/hubProxyHttp.ts";
import { layerRemoteHttpClient } from "../../../../packages/client-runtime/src/rpc/http.ts";
import type { RpcSession } from "../../../../packages/client-runtime/src/rpc/session.ts";
import type { WsRpcProtocolClient } from "../../../../packages/client-runtime/src/rpc/protocol.ts";

vi.mock("@goat/shared/goatConnect", async (original) => ({
  ...(await original<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));
class TestAuthApi extends HttpApi.make("environment").add(EnvironmentHttpApi.groups.auth) {}
const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);

it.effect.each(["managed", "learned direct"] as const)(
  "enabled %s discovery remints after same-account sign-out/sign-in and registers a protected node with HTTP 200",
  (route) =>
    Effect.gen(function* () {
      const identity = yield* Environment.ServerEnvironmentIdentity;
      const hubId = yield* identity.getEnvironmentId;
      const settings = yield* Settings.ServerSettingsService;
      yield* settings.start;
      yield* settings.updateSettings({ hub: { enabled: true, connectDevicesHubProxy: false } });
      const descriptor = decodeDescriptor({
        environmentId: hubId,
        label: "Hub",
        platform: { os: "linux", arch: "x64" },
        serverVersion: "test",
        capabilities: { hubProxy: true },
      });
      const authRoutes = HttpApiBuilder.layer(TestAuthApi).pipe(
        Layer.provide(AuthHttp.layer),
        Layer.provide(AuthHttp.layerAuthenticatedAuth),
        Layer.provide(HttpPlatform.layer.pipe(Layer.provide(Etag.layerWeak))),
      );
      const hub = yield* startHub({
        extraRoutes: Layer.merge(
          authRoutes,
          HttpRouter.add(
            "GET",
            "/.well-known/goat/environment",
            Effect.succeed(HttpServerResponse.jsonUnsafe(descriptor)),
          ),
        ),
      });
      const endpoint = {
        httpBaseUrl: hub.baseUrl,
        wsBaseUrl: hub.baseUrl.replace(/^http/u, "ws"),
        providerKind: "cloudflare_tunnel" as const,
      };
      const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", {
        namedCurve: "P-256",
      });
      const jwk = publicKey.export({ format: "jwk" }) as DpopPublicJwk;
      const thumbprint = computeDpopJwkThumbprint(jwk);
      let proofId = 0;
      const signer = Managed.ManagedRelayDpopSigner.of({
        thumbprint: Effect.succeed(thumbprint),
        createProof: Effect.fn("test.discoveryProof")(function* (input) {
          const encode = (value: unknown) =>
            Buffer.from(JSON.stringify(value)).toString("base64url");
          const data = `${encode({ alg: "ES256", typ: "dpop+jwt", jwk })}.${encode({ htm: input.method, htu: input.url, ...(input.accessToken === undefined ? {} : { ath: computeDpopAccessTokenHash(input.accessToken) }), iat: Math.floor((yield* DateTime.now).epochMilliseconds / 1000), jti: `discovery-${++proofId}` })}`;
          return `${data}.${NodeCrypto.sign("sha256", Buffer.from(data), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url")}`;
        }),
      });
      const account = yield* Ref.make<Option.Option<Capabilities.CloudSessionIdentity>>(
        Option.some({ accountId: "test-account" }),
      );
      const tokens = new Map<EnvironmentId, Tokens.RemoteDpopAccessToken>();
      let mints = 0;
      const clientServices = Layer.mergeAll(
        Layer.succeed(Managed.ManagedRelayDpopSigner, signer),
        Layer.mock(Managed.ManagedRelayClient)({
          relayUrl: "https://relay.test",
          connectEnvironment: () =>
            Effect.gen(function* () {
              mints++;
              const grant = yield* hub.auth.createCloudConnectPairingLink({
                proofKeyThumbprint: thumbprint,
              });
              return {
                environmentId: hubId,
                endpoint,
                credential: grant.credential,
                expiresAt: DateTime.formatIso(grant.expiresAt),
              };
            }).pipe(Effect.orDie),
        }),
        Layer.succeed(Capabilities.CloudSession, {
          identity: Ref.get(account),
          clerkToken: Effect.succeed("test-account-session"),
        }),
        Layer.succeed(Capabilities.RelayDeviceIdentity, {
          deviceId: Effect.succeedSome("test-device"),
        }),
        Layer.succeed(Capabilities.ClientPresentation, {
          metadata: { label: "Test phone", deviceType: "mobile" },
        }),
        Layer.succeed(Tokens.RemoteDpopAccessTokenStore, {
          get: (id) => Effect.sync(() => Option.fromUndefinedOr(tokens.get(id))),
          put: (token) =>
            Effect.sync(() => {
              tokens.set(token.environmentId, token);
            }),
          remove: (id) =>
            Effect.sync(() => {
              tokens.delete(id);
            }),
        }),
        layerRemoteHttpClient(fetch),
      );
      yield* Effect.gen(function* () {
        const remote = yield* Remote.RemoteEnvironmentAuthorization;
        const first = yield* remote.authorizeDpopHttp({ expectedEnvironmentId: hubId });
        const readStandard = requestHubProxyJson(
          { httpBaseUrl: first.httpBaseUrl, authorization: first.httpAuthorization, signer },
          "node-1",
          "/api/orchestration/shell",
          (value) => Effect.succeed(value),
        );
        expect(yield* readStandard.pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "permission" },
        });
        yield* settings.updateSettings({ hub: { connectDevicesHubProxy: true } });
        expect(yield* readStandard.pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { reason: "permission" },
        });
        expect(mints).toBe(1);
        const hubProfile = new BearerConnectionProfile({
          connectionId: "direct-hub",
          environmentId: hubId,
          label: "Hub",
          httpBaseUrl: hub.baseUrl,
          wsBaseUrl: endpoint.wsBaseUrl,
          authorization: "t3-connect",
        });
        const target =
          route === "managed"
            ? new RelayConnectionTarget({ environmentId: hubId, label: "Hub" })
            : new BearerConnectionTarget({
                environmentId: hubId,
                label: "Hub",
                connectionId: hubProfile.connectionId,
              });
        const config = { environment: descriptor } as ServerConfig;
        const configs = yield* SubscriptionRef.make(config);
        const snapshot: HubNodesSnapshot = {
          hubEnvironmentId: hubId,
          nodes: [
            {
              nodeId: sshNode.nodeId,
              environmentId: sshNode.environmentId,
              label: sshNode.label,
              kind: "ssh",
              status: "online",
              lastSeenAt: null,
              addedBy: null,
              routes: [
                {
                  routeId: "ssh:node",
                  source: "registered",
                  target: {
                    kind: "ssh",
                    alias: "node",
                    hostname: "node.test",
                    username: "test",
                    port: 22,
                  },
                  status: "online",
                  checkedAt: null,
                  lastSeenAt: null,
                  lastError: null,
                },
              ],
            },
          ],
          notices: [],
        };
        const session: RpcSession = {
          client: {
            [WS_METHODS.hubNodesSubscribe]: () =>
              Stream.make(snapshot).pipe(Stream.concat(Stream.never)),
          } as unknown as WsRpcProtocolClient,
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
        const savedProfiles = new Map<string, ConnectionProfile>([
          [hubProfile.connectionId, hubProfile],
        ]);
        const registrations = yield* Queue.unbounded<string>();
        const registryDependencies = Layer.mergeAll(
          Layer.succeed(Persistence.ConnectionTargetStore, {
            list: Effect.succeed([target]),
            listDisabled: Effect.succeed([]),
          }),
          Layer.mock(Persistence.ConnectionRegistrationStore)({
            register: (registration) =>
              Effect.sync(() => {
                if ("profile" in registration)
                  savedProfiles.set(registration.profile.connectionId, registration.profile);
              }),
          }),
          Layer.mock(Persistence.EnvironmentCacheStore)({}),
          Layer.succeed(Profiles.ConnectionProfileStore, {
            get: (id) => Effect.sync(() => Option.fromUndefinedOr(savedProfiles.get(id))),
            put: (profile) =>
              Effect.sync(() => {
                savedProfiles.set(profile.connectionId, profile);
              }),
            remove: (id) =>
              Effect.sync(() => {
                savedProfiles.delete(id);
              }),
          }),
          Layer.succeed(Credentials.ConnectionCredentialStore, {
            get: () => Effect.succeedNone,
            put: () => Effect.die("Hub credentials must not be stored on a node"),
            remove: () => Effect.void,
          }),
          Layer.mock(Capabilities.SshEnvironmentGateway)({}),
          Layer.succeed(Connectivity.Connectivity, {
            status: Effect.succeed("online" as const),
            changes: Stream.never,
          }),
          Layer.succeed(Wakeups.ConnectionWakeups, { changes: Stream.never }),
          Layer.succeed(Driver.ConnectionDriver, {
            connect: (entry) =>
              entry.target.environmentId !== hubId
                ? Effect.never
                : Effect.succeed({
                    session,
                    prepared: {
                      environmentId: hubId,
                      label: "Hub",
                      target,
                      httpBaseUrl: hub.baseUrl,
                      socketUrl: endpoint.wsBaseUrl,
                      httpAuthorization: first.httpAuthorization,
                    },
                  }),
            checkRoute: () => Effect.succeed("answered"),
            checkHost: () => Effect.succeed("answered"),
            preflight: () => Effect.succeed(true),
          }),
        );
        yield* Effect.gen(function* () {
          const registry = yield* Registry.EnvironmentRegistry;
          yield* registry.start;
          const authReads = yield* Queue.unbounded<void>();
          const tracer = Tracer.make({
            span: (options) => {
              const span = new Tracer.NativeSpan(options);
              const end = span.end.bind(span);
              span.end = (...args) => {
                end(...args);
                if (span.name === "clientRuntime.state.fetchEnvironmentSessionState")
                  Queue.offerUnsafe(authReads, undefined);
              };
              return span;
            },
          });
          yield* SubscriptionRef.changes(registry.entries).pipe(
            Stream.runForEach((entries) =>
              entries.has(sshNode.environmentId)
                ? Queue.offer(registrations, sshNode.environmentId)
                : Effect.void,
            ),
            Effect.forkScoped,
          );
          yield* watchConnectedHubProxyDiscovery.pipe(Effect.withTracer(tracer), Effect.forkScoped);
          yield* Queue.take(authReads);
          expect((yield* SubscriptionRef.get(registry.entries)).has(sshNode.environmentId)).toBe(
            false,
          );
          yield* Ref.set(account, Option.none());
          expect(
            yield* remote.authorizeDpopHttp({ expectedEnvironmentId: hubId }).pipe(Effect.result),
          ).toMatchObject({ _tag: "Failure" });
          yield* Ref.set(account, Option.some({ accountId: "test-account" }));
          yield* SubscriptionRef.set(configs, { ...config });
          expect(yield* Queue.take(registrations)).toBe(sshNode.environmentId);
          const entry = (yield* SubscriptionRef.get(registry.entries)).get(sshNode.environmentId);
          if (
            entry === undefined ||
            Option.isNone(entry.profile) ||
            entry.profile.value._tag !== "HubProxyConnectionProfile"
          )
            return yield* Effect.die("Expected the discovered proxy route");
          const source = yield* HubAuth.make;
          const auth = yield* source.resolve(entry.profile.value);
          const snapshot = yield* requestHubProxyJson(
            auth,
            "node-1",
            "/api/orchestration/shell",
            (value) => Effect.succeed(value),
          );
          expect(snapshot).toMatchObject({ projects: [], threads: [] });
          expect(mints).toBe(2);
          expect([...tokens.keys()]).toEqual([hubId]);
          const token = tokens.get(hubId);
          if (token === undefined) return yield* Effect.die("Expected a cached hub credential");
          expect((yield* hub.sessionStore.verify(token.accessToken)).scopes).toContain("hub:proxy");
        }).pipe(Effect.provide(Registry.layer.pipe(Layer.provideMerge(registryDependencies))));
      }).pipe(Effect.provide(Remote.layer.pipe(Layer.provideMerge(clientServices))));
    }).pipe(Effect.scoped, Effect.provide(authLayer)),
);
