// @effect-diagnostics nodeBuiltinImport:off -- Disposable incident signing keys, isolated auth storage and no network.
import { generateKeyPairSync } from "node:crypto";
import { vi } from "vite-plus/test";
import { it, expect } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { AuthStandardClientScopes, AuthHubProxyScope, EnvironmentId } from "@goat/contracts";
import {
  signRelayJwt,
  RELAY_MINT_REQUEST_TYP,
  RELAY_HOOK_DELIVERY_TYP,
  RELAY_HOOK_DELIVERY_HEADER,
} from "@goat/shared/relayJwt";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as CloudLinkRevocation from "./CloudLinkRevocation.ts";
import { RELAY_ENVIRONMENT_CREDENTIAL_SECRET, CLOUD_WITHDRAWAL_FENCE } from "./config.ts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as Semaphore from "effect/Semaphore";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as HttpServer from "effect/http/HttpServer";
import * as NetAddress from "effect/net/NetAddress";
import * as CloudLink from "./CloudLink.ts";
import * as ServerConfig from "../config.ts";
import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as SessionStore from "../auth/SessionStore.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Runtime from "./ManagedEndpointRuntime.ts";
import * as CliTokens from "./CliTokenManager.ts";
import * as Reachability from "./ConnectReachability.ts";
import * as Awareness from "../relay/AgentAwarenessRelay.ts";
import * as HookProof from "../scheduledTasks/RelayDeliveryProof.ts";

vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));
const environmentId = EnvironmentId.make("incident-fixture-env");
const environment = Layer.mergeAll(
  Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
    getEnvironmentId: Effect.succeed(environmentId),
  }),
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(environmentId),
    getDescriptor: Effect.die("descriptor not requested"),
  }),
);
const external = Layer.mergeAll(
  environment,
  Layer.effect(
    Runtime.CloudManagedEndpointRuntime,
    Effect.gen(function* () {
      const lock = yield* Semaphore.make(1);
      return Runtime.CloudManagedEndpointRuntime.of({
        applyConfig: () => Effect.succeed({ status: "disabled" }),
        inspectConnector: Effect.succeed(null),
        readinessChanged: Stream.empty,
        recoveryRequests: Stream.empty,
        requestRecovery: () => Effect.void,
        tunnelConnected: Stream.empty,
        withLinkStateLock: lock.withPermits(1),
      });
    }),
  ),
  Layer.succeed(Awareness.AgentAwarenessRelay, {
    publishThread: () => Effect.void,
    drain: Effect.void,
    requestCatchUp: () => Effect.void,
    start: () => Effect.void,
  }),
  Layer.mock(CliTokens.CloudCliTokenManager)({}),
  Layer.succeed(Reachability.ConnectReachability, {
    check: Effect.die("reachability is outside the incident fixture"),
    latest: Effect.succeedNone,
  }),
  Layer.mock(HttpServer.HttpServer)({
    address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
  }),
  Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.succeed(HttpClientResponse.fromWeb(request, new Response(null, { status: 404 }))),
    ),
  ),
);
const testLayer = CloudLink.layer.pipe(
  Layer.provideMerge(HookProof.layer),
  Layer.provideMerge(EnvironmentAuth.layer),
  Layer.provideMerge(ServerSecretStore.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provide(external),
  Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-key-incident-" })),
  Layer.provide(NodeServices.layer),
);

it.effect(
  "trusted unlink withdraws standard and hub credentials; reinstall rejects valid old-key mint and hook proofs while the new key works",
  () =>
    Effect.gen(function* () {
      const cloud = yield* CloudLink.CloudLink;
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const sessions = yield* SessionStore.SessionStore;
      const hooks = yield* HookProof.RelayDeliveryProof;
      const pair = () =>
        generateKeyPairSync("ed25519", {
          privateKeyEncoding: { type: "pkcs8", format: "pem" },
          publicKeyEncoding: { type: "spki", format: "pem" },
        });
      const oldKey = pair();
      const nextKey = pair();
      const install = (publicKey: string) =>
        cloud.applyRelayConfig({
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://relay.example.test",
          cloudUserId: "fixture-owner",
          environmentCredential: "fixture-credential",
          cloudMintPublicKey: publicKey,
          endpointRuntime: null,
        });
      yield* install(oldKey.publicKey);
      let nonce = 0;
      const mint = (privateKey: string) =>
        Effect.gen(function* () {
          const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
          return yield* cloud.mintCredential({
            proof: yield* signRelayJwt({
              privateKey,
              typ: RELAY_MINT_REQUEST_TYP,
              payload: {
                iss: "https://relay.example.test",
                aud: `goat-env:${environmentId}`,
                sub: "fixture-owner",
                environmentId,
                jti: `mint-${++nonce}`,
                nonce: `nonce-${nonce}`,
                iat: now,
                exp: now + 60,
                clientProofKeyThumbprint: "fixture-thumbprint",
                cnf: { jkt: "fixture-thumbprint" },
                scope: ["environment:connect"],
              },
            }),
          });
        });
      const bootstrap = yield* mint(oldKey.privateKey);
      const standard = yield* auth.issueSession({ subject: "cloud-connect" });
      const hub = yield* auth.issueSession({
        subject: "cloud-connect",
        scopes: [...AuthStandardClientScopes, AuthHubProxyScope],
      });
      const independent = yield* auth.issueSession({ subject: "independent-pairing" });
      const ticket = yield* sessions.issueWebSocketToken(hub.sessionId);
      const now = yield* DateTime.now;
      const receivedAt = DateTime.formatIso(now);
      const seconds = Math.floor(now.epochMilliseconds / 1000);
      const hook = yield* signRelayJwt({
        privateKey: oldKey.privateKey,
        typ: RELAY_HOOK_DELIVERY_TYP,
        payload: {
          iss: "https://relay.example.test",
          aud: `goat-env:${environmentId}`,
          sub: environmentId,
          environmentId,
          jti: "hook",
          iat: seconds,
          exp: seconds + 600,
          hookId: "hook-fixture",
          deliveryId: "delivery-fixture",
          receivedAt,
        },
      });
      const hookInput = {
        hookId: "hook-fixture",
        headers: {
          [RELAY_HOOK_DELIVERY_HEADER]: hook,
          "x-goat-relay-delivery-id": "delivery-fixture",
          "x-goat-relay-received-at": receivedAt,
        },
      };
      expect(Option.isSome(yield* hooks.verify(hookInput))).toBe(true);
      yield* cloud.unlink();
      expect((yield* sessions.verify(standard.token).pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* sessions.verify(hub.token).pipe(Effect.result))._tag).toBe("Failure");
      expect((yield* sessions.verifyWebSocketToken(ticket.token).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      yield* sessions.awaitInvalidation(hub.sessionId);
      expect(
        (yield* auth
          .exchangeBootstrapCredentialForAccessToken(
            bootstrap.credential,
            undefined,
            {},
            { proofKeyThumbprint: "fixture-thumbprint" },
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect((yield* sessions.verify(independent.token)).subject).toBe("independent-pairing");
      yield* install(nextKey.publicKey);
      expect((yield* Effect.flip(mint(oldKey.privateKey)))._tag).toBe(
        "CloudLinkProofRejectedError",
      );
      expect(Option.isNone(yield* hooks.verify(hookInput))).toBe(true);
      expect((yield* mint(nextKey.privateKey)).credential).toBeTruthy();
    }).pipe(Effect.provide(testLayer)),
);

it.effect.each([
  { receipt: false, failure: "journal" },
  { receipt: true, failure: "journal" },
  { receipt: false, failure: "fence" },
  { receipt: true, failure: "fence" },
])(
  "failed $failure persistence keeps relink fenced across service restart (receipt=$receipt)",
  ({ receipt, failure }) =>
    Effect.gen(function* () {
      const reached = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      let failSettlement = false;
      const journal = "cloud-link-withdrawal-journal";
      const secretsLayer = Layer.effect(
        ServerSecretStore.ServerSecretStore,
        Effect.gen(function* () {
          const base = yield* ServerSecretStore.ServerSecretStore;
          const fail = Effect.gen(function* () {
            yield* Deferred.succeed(reached, undefined);
            yield* Deferred.await(release);
            return yield* new ServerSecretStore.SecretStorePersistError({
              resource: journal,
              cause: "injected final journal persistence failure",
            });
          });
          return ServerSecretStore.ServerSecretStore.of({
            ...base,
            set: (name, value) =>
              failSettlement &&
              failure === "journal" &&
              name === journal &&
              !new TextDecoder().decode(value).includes("local_pending")
                ? fail
                : base.set(name, value),
            remove: (name) =>
              failSettlement && name === (failure === "journal" ? journal : CLOUD_WITHDRAWAL_FENCE)
                ? fail
                : base.remove(name),
          });
        }),
      ).pipe(Layer.provide(ServerSecretStore.layer));
      const services = CloudLink.layer.pipe(
        Layer.provideMerge(EnvironmentAuth.layer),
        Layer.provideMerge(external),
      );
      const pair = generateKeyPairSync("ed25519", {
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      const install = (cloud: CloudLink.CloudLink["Service"], credential: string) =>
        cloud.applyRelayConfig({
          relayUrl: "https://relay.example.test",
          relayIssuer: "https://relay.example.test",
          cloudUserId: credential,
          environmentCredential: credential,
          cloudMintPublicKey: pair.publicKey,
          endpointRuntime: null,
        });
      yield* Effect.gen(function* () {
        yield* Effect.gen(function* () {
          const cloud = yield* CloudLink.CloudLink;
          const auth = yield* EnvironmentAuth.EnvironmentAuth;
          const revoke = yield* CloudLinkRevocation.make;
          yield* install(cloud, "old-installation");
          const old = yield* auth.issueSession({ subject: "cloud-connect" });
          failSettlement = true;
          const withdrawal = yield* revoke
            .withdrawInstalledLink("old-installation", receipt ? "receipt-old" : undefined)
            .pipe(Effect.result, Effect.forkChild);
          yield* Deferred.await(reached);
          const relink = yield* install(cloud, "new-installation").pipe(
            Effect.result,
            Effect.forkChild,
          );
          yield* Deferred.succeed(release, undefined);
          expect((yield* Fiber.join(withdrawal))._tag).toBe("Failure");
          expect((yield* Fiber.join(relink))._tag).toBe("Failure");
          expect(
            (yield* (yield* SessionStore.SessionStore).verify(old.token).pipe(Effect.result))._tag,
          ).toBe("Failure");
        }).pipe(Effect.provide(Layer.fresh(services)));
        failSettlement = false;
        yield* Effect.gen(function* () {
          const cloud = yield* CloudLink.CloudLink;
          const revoke = yield* CloudLinkRevocation.make;
          const auth = yield* EnvironmentAuth.EnvironmentAuth;
          yield* revoke.resumeLocal;
          yield* install(cloud, "new-installation");
          let fresh = yield* auth.issueSession({ subject: "cloud-connect" });
          yield* revoke.resumeLocal;
          expect((yield* (yield* SessionStore.SessionStore).verify(fresh.token)).subject).toBe(
            "cloud-connect",
          );
          const secrets = yield* ServerSecretStore.ServerSecretStore;
          expect(
            new TextDecoder().decode(
              Option.getOrThrow(yield* secrets.get(RELAY_ENVIRONMENT_CREDENTIAL_SECRET)),
            ),
          ).toBe("new-installation");
          if (receipt) {
            // An old ack must not settle a new unlink whose first journal write failed.
            yield* secrets.set(CLOUD_WITHDRAWAL_FENCE, new TextEncoder().encode("pending"));
            yield* revoke.resumeLocal;
            expect(
              (yield* (yield* SessionStore.SessionStore).verify(fresh.token).pipe(Effect.result))
                ._tag,
            ).toBe("Failure");
            expect(Option.isNone(yield* secrets.get(RELAY_ENVIRONMENT_CREDENTIAL_SECRET))).toBe(
              true,
            );
            yield* install(cloud, "new-installation");
            fresh = yield* auth.issueSession({ subject: "cloud-connect" });
          }
          yield* secrets.set(
            journal,
            new TextEncoder().encode(
              JSON.stringify([
                {
                  phase: "local_pending",
                  relayUrl: "https://relay.example.test",
                  credential: "old-installation",
                  environmentId,
                },
              ]),
            ),
          );
          expect((yield* revoke.resumeLocal.pipe(Effect.result))._tag).toBe("Failure");
          expect((yield* install(cloud, "third-installation").pipe(Effect.result))._tag).toBe(
            "Failure",
          );
          expect((yield* (yield* SessionStore.SessionStore).verify(fresh.token)).subject).toBe(
            "cloud-connect",
          );
          expect(
            new TextDecoder().decode(
              Option.getOrThrow(yield* secrets.get(RELAY_ENVIRONMENT_CREDENTIAL_SECRET)),
            ),
          ).toBe("new-installation");
        }).pipe(Effect.provide(Layer.fresh(services)));
      }).pipe(
        Effect.provide(Layer.mergeAll(secretsLayer, Sqlite.layerMemory)),
        Effect.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "goat-withdrawal-journal-" }),
        ),
        Effect.provide(NodeServices.layer),
      );
    }),
);
