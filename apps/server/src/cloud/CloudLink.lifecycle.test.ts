import { vi } from "vite-plus/test";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientResponse, HttpServer, type HttpClientRequest } from "effect/http";
import * as NetAddress from "effect/net/NetAddress";

import { EnvironmentId } from "@goat/contracts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfigModule from "../config.ts";
import { writeServiceState } from "../serviceLauncher.ts";
import {
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_STATE_FILE,
  SERVICE_STOP_MARKER_FILE,
  type ServiceUpdateRecord,
} from "./serviceProtocol.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import { CLOUD_CLI_DESIRED_LINK_SECRET } from "./CliState.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import {
  CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINKED_USER_ID,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";
import * as CloudLink from "./CloudLink.ts";
import * as ConnectReachability from "./ConnectReachability.ts";
import { consumeCloudReplayGuards } from "./CloudLink.ts";
import { pendingServiceUpdateExists } from "./updateHandoff.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";

const storeFailure = (tag: "AlreadyExists" | "PermissionDenied") =>
  new ServerSecretStore.SecretStorePersistError({
    resource: "cloud replay guard",
    cause: PlatformError.systemError({
      _tag: tag,
      module: "FileSystem",
      method: "open",
      pathOrDescriptor: "cloud-replay-guard.bin",
    }),
  });

const unusedSecretStoreOperation = () => Effect.die("unused secret-store operation");

const idleAwarenessRelay = AgentAwarenessRelay.AgentAwarenessRelay.of({
  publishThread: () => Effect.void,
  drain: Effect.void,
  requestCatchUp: () => Effect.void,
  start: () => Effect.void,
});

const idleHttpServer = HttpServer.HttpServer.of({
  address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
  serve: (() => Effect.void) as HttpServer.HttpServer["Service"]["serve"],
});

function makeSecretStore(
  create: ServerSecretStore.ServerSecretStore["Service"]["create"],
): ServerSecretStore.ServerSecretStore["Service"] {
  return {
    get: unusedSecretStoreOperation,
    set: unusedSecretStoreOperation,
    create,
    getOrCreateRandom: unusedSecretStoreOperation,
    remove: unusedSecretStoreOperation,
  };
}

describe("consumeCloudReplayGuards", () => {
  it.effect("reports already-created guards as replay conflicts", () =>
    Effect.gen(function* () {
      const consumed = yield* consumeCloudReplayGuards({
        secrets: makeSecretStore(() => Effect.fail(storeFailure("AlreadyExists"))),
        names: ["cloud-jti", "cloud-nonce"],
        value: new Uint8Array(),
      });

      expect(consumed).toBe(false);
    }),
  );
});

describe("releaseManagedTunnelOnShutdown", () => {
  const cliToken: CliTokenManager.PersistedToken = {
    accessToken: "cli-access-token",
    refreshToken: "cli-refresh-token",
    expiresAtEpochMs: Number.MAX_SAFE_INTEGER,
  };

  function makeMemorySecretStore(initial: Iterable<readonly [string, string]> = []) {
    const values = new Map<string, Uint8Array>(
      Array.from(initial, ([name, value]) => [name, new TextEncoder().encode(value)] as const),
    );
    const store: ServerSecretStore.ServerSecretStore["Service"] = {
      get: (name) => Effect.sync(() => Option.fromNullishOr(values.get(name))),
      set: (name, value) =>
        Effect.sync(() => {
          values.set(name, value);
        }),
      create: (name, value) =>
        Effect.sync(() => {
          values.set(name, value);
        }),
      getOrCreateRandom: unusedSecretStoreOperation,
      remove: (name) =>
        Effect.sync(() => {
          values.delete(name);
        }),
    };
    return { store, values };
  }

  interface ReleaseHarness {
    readonly store: ServerSecretStore.ServerSecretStore["Service"];
    readonly applyConfigCalls: Array<unknown>;
    readonly requests: Array<HttpClientRequest.HttpClientRequest>;
    readonly onRequest?: (request: HttpClientRequest.HttpClientRequest) => Effect.Effect<void>;
    readonly respond?: () => Response;
    readonly address?: HttpServer.HttpServer["Service"]["address"];
    readonly respondEffect?: Effect.Effect<Response>;
    readonly getExisting?: CliTokenManager.CloudCliTokenManager["Service"]["getExisting"];
  }

  const writeLauncherState = (update: ServiceUpdateRecord) =>
    Effect.gen(function* () {
      const path = yield* Path.Path;
      const config = yield* ServerConfigModule.ServerConfig;
      const statePath = path.join(config.baseDir, "runtime", SERVICE_STATE_FILE);
      yield* Effect.promise(() =>
        writeServiceState(statePath, {
          protocol: SERVICE_LAUNCHER_PROTOCOL,
          activeVersion: "0.0.30",
          update,
        }),
      );
    });

  const provideReleaseHarness =
    (harness: ReleaseHarness) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.provide(CloudLink.layer),
        Effect.provideService(
          ConnectReachability.ConnectReachability,
          ConnectReachability.ConnectReachability.of({
            check: Effect.die("unused"),
            latest: Effect.succeedNone,
          }),
        ),
        Effect.provideService(HttpServer.HttpServer, {
          ...idleHttpServer,
          address: harness.address ?? idleHttpServer.address,
        }),
        Effect.provideService(ServerSecretStore.ServerSecretStore, harness.store),
        Effect.provideService(AgentAwarenessRelay.AgentAwarenessRelay, idleAwarenessRelay),
        Effect.provideService(
          ServerEnvironment.ServerEnvironment,
          ServerEnvironment.ServerEnvironment.of({
            getEnvironmentId: Effect.succeed(EnvironmentId.make("env_123")),
            getDescriptor: Effect.die("unused"),
          }),
        ),
        Effect.provideService(
          ManagedEndpointRuntime.CloudManagedEndpointRuntime,
          ManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
            applyConfig: (config) =>
              Effect.sync(() => {
                harness.applyConfigCalls.push(config);
                return config === null
                  ? ({
                      status: "disabled",
                    } satisfies ManagedEndpointRuntime.CloudManagedEndpointRuntimeStatus)
                  : ({
                      status: "running",
                      providerKind: "cloudflare_tunnel",
                      pid: 123,
                    } satisfies ManagedEndpointRuntime.CloudManagedEndpointRuntimeStatus);
              }),
            recoveryRequests: Stream.empty,
            requestRecovery: () => Effect.void,
            tunnelConnected: Stream.empty,
            inspectConnector: Effect.succeed(null),
            readinessChanged: Stream.empty,
            withLinkStateLock: (effect) => effect,
          }),
        ),
        Effect.provideService(
          EnvironmentAuth.EnvironmentAuth,
          EnvironmentAuth.EnvironmentAuth.of({
            setCloudLinkTrust: () => Effect.void,
            withCloudCredentialPermit: (effect) => effect,
            withdrawCloudCredentials: () => Effect.void,
            completeCloudWithdrawal: () => Effect.void,
          } as EnvironmentAuth.EnvironmentAuth["Service"]),
        ),
        Effect.provideService(
          CliTokenManager.CloudCliTokenManager,
          CliTokenManager.CloudCliTokenManager.of({
            approveLink: () => Effect.die("unused"),
            get: unusedSecretStoreOperation(),
            getExisting: harness.getExisting ?? Effect.succeedSome(cliToken),
            hasCredential: unusedSecretStoreOperation(),
            store: () => unusedSecretStoreOperation(),
            clear: unusedSecretStoreOperation(),
          }),
        ),
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            request.url.includes("/cloud-revocation")
              ? Effect.succeed(
                  HttpClientResponse.fromWeb(request, new Response(null, { status: 404 })),
                )
              : Effect.sync(() => {
                  harness.requests.push(request);
                }).pipe(
                  Effect.andThen(harness.onRequest?.(request) ?? Effect.void),
                  Effect.andThen(
                    harness.respondEffect ??
                      Effect.sync(() => (harness.respond ?? (() => Response.json({ ok: true })))()),
                  ),
                  Effect.map((response) => HttpClientResponse.fromWeb(request, response)),
                ),
          ),
        ),

        Effect.provide(
          ServerConfigModule.layerTest("/", { prefix: "goat-http-release-test-" }).pipe(
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
        Effect.scoped,
      );

  const managedLinkSecrets = [
    [CLOUD_ENDPOINT_RUNTIME_CONFIG, "runtime-config"],
    [CLOUD_ENDPOINT_CONFIRMED_ORIGIN, "confirmed-origin"],
    [RELAY_URL_SECRET, "https://relay.example.test"],
    [CLOUD_CLI_DESIRED_LINK_SECRET, "managed"],
  ] as const;

  it.effect("does not recreate a link that was unlinked while startup registration retried", () => {
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;

      values.delete(CLOUD_CLI_DESIRED_LINK_SECRET);

      expect(yield* link.reconcileDesiredLinkIfStillDesired("http://127.0.0.1:3773")).toBeNull();
      expect(requests).toEqual([]);
      expect(applyConfigCalls).toEqual([]);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("stops the connector, releases the relay tunnel, and drops the dead token", () => {
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const released = yield* link.releaseManagedTunnelOnShutdown();

      expect(released).toBe(true);
      expect(applyConfigCalls).toEqual([null]);
      expect(requests).toHaveLength(1);
      const request = requests[0]!;
      expect(request.method).toBe("DELETE");
      expect(request.url).toBe(
        "https://relay.example.test/v1/client/environment-links/env_123/tunnel",
      );
      expect(request.headers.authorization).toBe("Bearer cli-access-token");
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(false);
      expect(values.has(CLOUD_ENDPOINT_CONFIRMED_ORIGIN)).toBe(false);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("leaves the tunnel of a web/mobile-installed link untouched", () => {
    const { store, values } = makeMemorySecretStore([
      [CLOUD_ENDPOINT_RUNTIME_CONFIG, "runtime-config"],
      [RELAY_URL_SECRET, "https://relay.example.test"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const released = yield* link.releaseManagedTunnelOnShutdown();

      expect(released).toBe(false);
      expect(applyConfigCalls).toEqual([]);
      expect(requests).toEqual([]);
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(true);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("keeps the tunnel when shutdown hands off to a pending update", () => {
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      yield* writeLauncherState({
        id: "update-1",
        fromVersion: "0.0.30",
        targetVersion: "0.0.31",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      });

      const released = yield* link.releaseManagedTunnelOnShutdown();

      expect(released).toBe(false);
      expect(applyConfigCalls).toEqual([]);
      expect(requests).toEqual([]);
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(true);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("still releases a pending update when the launcher is stopping", () => {
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      yield* writeLauncherState({
        id: "update-1",
        fromVersion: "0.0.30",
        targetVersion: "0.0.31",
        dbPath: "/tmp/state.sqlite",
        status: "pending",
      });
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfigModule.ServerConfig;
      yield* fs.writeFileString(path.join(config.baseDir, "runtime", SERVICE_STOP_MARKER_FILE), "");

      expect(yield* pendingServiceUpdateExists).toBe(true);
      const released = yield* link.releaseManagedTunnelOnShutdown();

      expect(released).toBe(true);
      expect(requests).toHaveLength(1);
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(false);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  // regression: 808d6853555 keep the managed tunnel across remote update restarts
  it.effect("still releases when the recorded update already settled", () => {
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      yield* writeLauncherState({
        id: "update-1",
        fromVersion: "0.0.30",
        targetVersion: "0.0.31",
        status: "committed",
      });

      const released = yield* link.releaseManagedTunnelOnShutdown();

      expect(released).toBe(true);
      expect(requests).toHaveLength(1);
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(false);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("keeps a runtime config that a fast restart replaced mid-release", () => {
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const freshConfig = new TextEncoder().encode("fresh-runtime-config");

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const released = yield* link.releaseManagedTunnelOnShutdown();

      expect(released).toBe(true);

      expect(values.get(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(freshConfig);
    }).pipe(
      provideReleaseHarness({
        store,
        applyConfigCalls,
        requests,
        respond: () => {
          values.set(CLOUD_ENDPOINT_RUNTIME_CONFIG, freshConfig);
          return Response.json({ ok: true });
        },
      }),
    );
  });

  it.effect("keeps the stored connector token when the relay skipped the release", () => {
    const { store, values } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const released = yield* link.releaseManagedTunnelOnShutdown();

      expect(released).toBe(false);
      expect(requests).toHaveLength(1);
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(true);
    }).pipe(
      provideReleaseHarness({
        store,
        applyConfigCalls,
        requests,
        respond: () => Response.json({ ok: false }),
      }),
    );
  });

  it.effect(
    "requires a fresh relink for an unconfirmed retained tunnel without calling the relay",
    () => {
      const config = {
        providerKind: "cloudflare_tunnel",
        connectorToken: "existing-token",
        tunnelId: "existing-tunnel",
      };
      const { store } = makeMemorySecretStore([
        [CLOUD_ENDPOINT_RUNTIME_CONFIG, JSON.stringify(config)],
        [RELAY_URL_SECRET, "https://relay.example.test"],
        [CLOUD_LINKED_USER_ID, "user-123"],
        [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "credential"],
        ["cloud-connect-auth-policy-version", "1"],
      ]);
      const applyConfigCalls: Array<unknown> = [];
      const requests: Array<HttpClientRequest.HttpClientRequest> = [];
      return Effect.gen(function* () {
        const link = yield* CloudLink.CloudLink;
        expect(yield* link.registerManagedTunnelRecovery("http://127.0.0.1:3773")).toEqual({
          status: "recovery_required",
          config,
        });
        expect(yield* link.recoverManagedTunnel("http://127.0.0.1:3773")).toBe(false);
        expect(requests).toEqual([]);
        expect(applyConfigCalls).toEqual([]);
      }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
    },
  );
  it.effect("retains a confirmed policy-1 connector through normal shutdown and startup", () => {
    const config = {
      providerKind: "cloudflare_tunnel",
      connectorToken: "existing-token",
      tunnelId: "existing-tunnel",
    };
    const { store } = makeMemorySecretStore([
      [CLOUD_ENDPOINT_RUNTIME_CONFIG, JSON.stringify(config)],
      [
        CLOUD_ENDPOINT_CONFIRMED_ORIGIN,
        JSON.stringify({ config, origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 } }),
      ],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "credential"],
      ["cloud-connect-auth-policy-version", "1"],
    ]);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      yield* link.applyRelayConfig({
        connectAuthPolicyVersion: 1,
        relayUrl: "https://relay.example.test",
        cloudUserId: "user-123",
        environmentCredential: "approved-credential",
        endpointRuntime: config,
        cloudMintPublicKey:
          "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAMY09Vo5CzEA6aEkhB/0h27t4Qs71SHS1fTSI4K0KvZQ=\n-----END PUBLIC KEY-----\n",
      });
      expect(yield* link.releaseManagedTunnelOnShutdown()).toBe(false);
      expect(yield* link.registerManagedTunnelRecovery("http://127.0.0.1:3773")).toMatchObject({
        status: "ready",
      });
      expect(
        yield* link.startManagedTunnelIfOriginConfirmed("http://127.0.0.1:4884", {
          requireConfirmedOrigin: false,
        }),
      ).toBe(false);
      expect(requests).toEqual([]);
      expect(applyConfigCalls).toEqual([null, config, config]);
    }).pipe(
      provideReleaseHarness({
        store,
        applyConfigCalls,
        requests,
        getExisting: Effect.die("Retained connectors cannot request OAuth or new credentials"),
      }),
    );
  });
  it.effect("cannot relink at startup with only cached OAuth and a desired-link flag", () => {
    const { store } = makeMemorySecretStore(managedLinkSecrets);
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      expect(
        (yield* link.reconcileDesiredLink("http://127.0.0.1:3773").pipe(Effect.flip))._tag,
      ).toBe("CloudLinkAuthorizationMissingError");
      expect(requests).toEqual([]);
      expect(applyConfigCalls).toEqual([]);
    }).pipe(provideReleaseHarness({ store, applyConfigCalls, requests }));
  });

  it.effect("does not report a managed tunnel after a relay config write fails part-way", () => {
    const { store, values } = makeMemorySecretStore([
      [CLOUD_ENDPOINT_RUNTIME_CONFIG, "managed-config"],
      [CLOUD_ENDPOINT_CONFIRMED_ORIGIN, "confirmed-origin"],
      [RELAY_URL_SECRET, "https://relay.example.test"],
      [CLOUD_LINKED_USER_ID, "user-123"],
      [RELAY_ENVIRONMENT_CREDENTIAL_SECRET, "old-credential"],
    ]);
    const failingStore: ServerSecretStore.ServerSecretStore["Service"] = {
      ...store,
      set: (name, value) =>
        name === RELAY_ISSUER_SECRET
          ? Effect.fail(
              new ServerSecretStore.SecretStorePersistError({
                resource: name,
                cause: PlatformError.systemError({
                  _tag: "PermissionDenied",
                  module: "FileSystem",
                  method: "rename",
                  pathOrDescriptor: `${name}.bin`,
                }),
              }),
            )
          : store.set(name, value),
    };
    const applyConfigCalls: Array<unknown> = [];
    const requests: Array<HttpClientRequest.HttpClientRequest> = [];
    const cloudMintPublicKey =
      "-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAMY09Vo5CzEA6aEkhB/0h27t4Qs71SHS1fTSI4K0KvZQ=\n-----END PUBLIC KEY-----\n";

    return Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const error = yield* Effect.flip(
        link.applyRelayConfig({
          connectAuthPolicyVersion: 1,
          relayUrl: "https://relay.example.test",
          cloudUserId: "user-123",
          environmentCredential: "new-credential",
          cloudMintPublicKey,
          endpointRuntime: null,
        }),
      );

      expect(error._tag).toBe("CloudLinkInternalError");
      expect(yield* link.linkState()).toMatchObject({
        linked: true,
        cloudUserId: "user-123",
        managedTunnelActive: false,
      });
      expect(values.has(CLOUD_ENDPOINT_RUNTIME_CONFIG)).toBe(false);
    }).pipe(provideReleaseHarness({ store: failingStore, applyConfigCalls, requests }));
  });
});

vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));
