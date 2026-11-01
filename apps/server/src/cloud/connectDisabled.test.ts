import * as ConnectReachability from "./ConnectReachability.ts";
import { EnvironmentAuthenticatedPrincipal } from "@goat/contracts";
import { expect, it } from "@effect/vitest";
import { ThreadId } from "@goat/contracts";
import * as Context from "effect/Context";
import * as Stream from "effect/Stream";
import { RelayClient } from "@goat/shared/relayClient";
import { installRelayClient } from "./installRelayClient.ts";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { FetchHttpClient, HttpClient, HttpServer } from "effect/http";
import * as RelayTracing from "@goat/shared/relayTracing";
import { vi } from "vite-plus/test";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as AgentAwarenessRelay from "../relay/AgentAwarenessRelay.ts";
import * as HeldHooksWaker from "../relay/HeldHooksWaker.ts";
import * as ServerActivation from "../serverActivation.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import * as CloudLink from "./CloudLink.ts";
import * as ManagedEndpointRuntime from "./ManagedEndpointRuntime.ts";
import { desiredLinkReconcileStartup } from "./DesiredLinkReconcile.ts";
import {
  readAgentActivityPublishingActive,
  readHoldWebhooksWhileOffline,
  readRelayConnection,
} from "./config.ts";

const failOnUse = <I, S extends object>(key: Context.Key<I, S>) =>
  Layer.succeed(
    key,
    new Proxy({} as S, {
      get: (_target, property) => {
        throw new Error(`Unexpected ${key.key}.${String(property)}`);
      },
    }),
  );

const dependencies = Layer.mergeAll(
  failOnUse(ConnectReachability.ConnectReachability),
  failOnUse(EnvironmentAuthenticatedPrincipal),
  failOnUse(ServerSecretStore.ServerSecretStore),
  failOnUse(ServerEnvironment.ServerEnvironment),
  failOnUse(ManagedEndpointRuntime.CloudManagedEndpointRuntime),
  failOnUse(EnvironmentAuth.EnvironmentAuth),
  failOnUse(CliTokenManager.CloudCliTokenManager),
  failOnUse(HttpClient.HttpClient),
  failOnUse(HttpServer.HttpServer),
  failOnUse(AgentAwarenessRelay.AgentAwarenessRelay),
  failOnUse(Crypto.Crypto),
  failOnUse(ServerConfig.ServerConfig),
  failOnUse(FileSystem.FileSystem),
  failOnUse(Path.Path),
  failOnUse(ThreadManagement.ThreadManagementService),
  failOnUse(ProjectService.ProjectService),
);

it.effect("returns a local disabled CloudLink without acquiring cloud dependencies", () =>
  Effect.gen(function* () {
    const cloud = yield* CloudLink.CloudLink;
    expect(yield* cloud.linkState()).toEqual({
      linked: false,
      linkRevoked: false,
      cloudUserId: null,
      relayUrl: null,
      relayIssuer: null,
      managedTunnelActive: false,
      publishAgentActivity: false,
      holdWebhooksWhileOffline: false,
    });
    expect(yield* cloud.unlink()).toEqual({
      ok: true,
      endpointRuntimeStatus: { status: "disabled" },
    });
    const proof = { challenge: "invalid-disabled-input" } as unknown as Parameters<
      typeof cloud.linkProof
    >[0];
    const request = {} as Parameters<typeof cloud.linkProof>[1];
    const config = {} as Parameters<typeof cloud.applyRelayConfig>[0];
    const health = {} as Parameters<typeof cloud.answerHealthRequest>[0];
    const credential = {} as Parameters<typeof cloud.mintCredential>[0];
    const errors = [
      yield* cloud.linkProof(proof, request).pipe(Effect.flip),
      yield* cloud.applyRelayConfig(config).pipe(Effect.flip),
      yield* cloud
        .updatePreferences({ publishAgentActivity: true, holdWebhooksWhileOffline: true })
        .pipe(Effect.flip),
      yield* cloud.answerHealthRequest(health).pipe(Effect.flip),
      yield* cloud.mintCredential(credential).pipe(Effect.flip),
      yield* cloud.reconcileDesiredLink("http://127.0.0.1:43167").pipe(Effect.flip),
      yield* cloud.reconcileDesiredLinkIfStillDesired("http://127.0.0.1:43167").pipe(Effect.flip),
      yield* cloud.registerManagedTunnelRecovery("http://127.0.0.1:43167").pipe(Effect.flip),
      yield* cloud.recoverManagedTunnel("http://127.0.0.1:43167").pipe(Effect.flip),
      yield* cloud.startManagedTunnelIfOriginConfirmed("http://127.0.0.1:43167").pipe(Effect.flip),
      yield* cloud.releaseManagedTunnelOnShutdown().pipe(Effect.flip),
    ];
    for (const error of errors) {
      expect(error).toMatchObject({
        _tag: "CloudLinkInternalError",
        operation: "connect-disabled",
      });
    }
  }).pipe(
    Effect.provide(
      Layer.merge(
        CloudLink.layer.pipe(Layer.provide(dependencies)),
        failOnUse(EnvironmentAuthenticatedPrincipal),
      ),
    ),
  ),
);

it.effect(
  "skips previously linked startup reconcile without reading or mutating secrets or installing finalizers",
  () =>
    Effect.gen(function* () {
      const config = {
        providerKind: "cloudflare_tunnel",
        connectorToken: "synthetic",
        tunnelId: "11111111-1111-4111-8111-111111111111",
        tunnelName: "wp1-startup-fixture",
      };
      for (const desiredMode of ["managed", "publish_only", null]) {
        const secrets = new Map<string, string>(
          Object.entries({
            "cloud-cli-oauth-token": JSON.stringify({
              accessToken: "expired",
              refreshToken: "synthetic",
              expiresAtEpochMs: 0,
            }),
            "cloud-relay-url": "https://relay.wp1.invalid",
            "cloud-relay-issuer": "https://relay.wp1.invalid",
            "cloud-linked-user-id": "user_wp1_synthetic",
            "cloud-relay-environment-credential": "synthetic",
            "cloud-endpoint-runtime-config": JSON.stringify(config),
            "cloud-endpoint-confirmed-origin": JSON.stringify({
              config,
              origin: { localHttpHost: "127.0.0.1", localHttpPort: 43167 },
            }),
            "cloud-publish-agent-activity": "true",
            "cloud-hold-webhooks-while-offline": "true",
            "cloud-link-ed25519-key-pair": "malformed-legacy-key-must-not-migrate",
          }),
        );
        if (desiredMode) secrets.set("cloud-cli-desired-link", desiredMode);
        const before = [...secrets];
        const reads = vi.fn((name: string) =>
          Effect.die(`Unexpected secret read ${name}: ${secrets.get(name)}`),
        );
        const writes = vi.fn(() => Effect.die("Unexpected secret write"));
        const secretStore = ServerSecretStore.ServerSecretStore.of({
          get: reads,
          set: writes,
          create: writes,
          remove: writes,
          getOrCreateRandom: writes,
        });
        const parked = yield* Deferred.make<void>();
        const activation = yield* Deferred.make<void>();
        const startup = desiredLinkReconcileStartup(parked);
        expect(startup.awaitParked).toHaveLength(0);
        yield* Layer.build(startup.layer).pipe(
          Effect.scoped,
          Effect.provideService(ServerActivation.ServerActivation, Deferred.await(activation)),
          Effect.provideService(ServerSecretStore.ServerSecretStore, secretStore),
          Effect.provide(Layer.merge(dependencies, failOnUse(CloudLink.CloudLink))),
        );
        expect(yield* Deferred.isDone(activation)).toBe(false);
        expect(reads).not.toHaveBeenCalled();
        expect(writes).not.toHaveBeenCalled();
        expect([...secrets]).toEqual(before);
      }
    }),
);

it.effect("keeps relay readers, awareness workers, and held-hook subscriptions inactive", () =>
  Effect.gen(function* () {
    const secretStore = yield* ServerSecretStore.ServerSecretStore;
    expect(yield* readAgentActivityPublishingActive(secretStore)).toBe(false);
    expect(yield* readRelayConnection).toBeNull();
    expect(yield* readHoldWebhooksWhileOffline).toBe(false);
    const relay = yield* AgentAwarenessRelay.make;
    yield* relay.start();
    yield* relay.publishThread(ThreadId.make("disabled-thread"));
    yield* relay.requestCatchUp();
    yield* relay.drain;
    yield* Layer.build(HeldHooksWaker.layer);
  }).pipe(Effect.scoped, Effect.provide(dependencies)),
);

it.effect("does not create or flush a relay exporter with valid OTLP configuration", () => {
  const fetch = vi.fn<typeof globalThis.fetch>(() =>
    Promise.reject(new Error("Unexpected OTLP HTTP")),
  );
  const tracing = RelayTracing.layer(
    {
      tracesUrl: "https://collector.wp1.invalid/v1/traces",
      tracesDataset: "relay",
      tracesToken: "synthetic",
    },
    { serviceName: "wp1", serviceInstanceId: "wp1-test", runtime: "test", client: "test" },
  ).pipe(
    Layer.provide(FetchHttpClient.layer),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)),
  );
  return Effect.gen(function* () {
    yield* Effect.void.pipe(
      Effect.withSpan("relay.disabled"),
      RelayTracing.withRelayClientTracing,
      Effect.provide(tracing),
      Effect.scoped,
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

it.effect("fails the installer stream locally without invoking the installer", () =>
  Effect.gen(function* () {
    const installer = yield* RelayClient;
    const error = yield* installRelayClient(installer).pipe(Stream.runDrain, Effect.flip);
    expect(error).toMatchObject({
      _tag: "RelayClientInstallFailedError",
      reason: "unsupported_platform",
      message: "GOAT Connect is coming soon. Connect with Tailscale for now.",
    });
  }).pipe(Effect.provide(failOnUse(RelayClient))),
);
