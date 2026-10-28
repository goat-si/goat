// @effect-diagnostics-next-line nodeBuiltinImport:off -- real Ed25519 relay proofs for the mint boundary.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { AuthHubProxyScope, AuthStandardClientScopes } from "@goat/contracts";
import { RELAY_MINT_REQUEST_TYP, signRelayJwt } from "@goat/shared/relayJwt";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import { FetchHttpClient, HttpServer } from "effect/http";
import * as Auth from "../auth/EnvironmentAuth.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Sessions from "../auth/SessionStore.ts";
import * as Config from "../config.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Settings from "../serverSettings.ts";
import * as Awareness from "../relay/AgentAwarenessRelay.ts";
import * as Cli from "./CliTokenManager.ts";
import * as CloudLink from "./CloudLink.ts";
import * as Reachability from "./ConnectReachability.ts";
import * as Endpoint from "./ManagedEndpointRuntime.ts";

vi.mock("@goat/shared/goatConnect", async (original) => ({
  ...(await original<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));
const layerEnvironment = Layer.effect(
  Environment.ServerEnvironment,
  Effect.gen(function* () {
    const identity = yield* Environment.ServerEnvironmentIdentity;
    return Environment.ServerEnvironment.of({
      getEnvironmentId: identity.getEnvironmentId,
      getDescriptor: Effect.die("unused descriptor"),
    });
  }),
);
const layer = CloudLink.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(Auth.layer, Settings.layer)),
  Layer.provide(layerEnvironment),
  Layer.provide(Layer.mock(Awareness.AgentAwarenessRelay)({ requestCatchUp: () => Effect.void })),
  Layer.provide(Layer.mock(Cli.CloudCliTokenManager)({})),
  Layer.provide(Layer.mock(Reachability.ConnectReachability)({ latest: Effect.succeedNone })),
  Layer.provide(
    Layer.mock(Endpoint.CloudManagedEndpointRuntime)({
      applyConfig: () => Effect.succeed({ status: "disabled" }),
      withLinkStateLock: (effect) => effect,
    }),
  ),
  Layer.provide(
    Layer.mock(HttpServer.HttpServer)({
      address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
    }),
  ),
  Layer.provideMerge(Secrets.layer),
  Layer.provideMerge(Environment.layerIdentity),
  Layer.provide(Sqlite.layerMemory),
  Layer.provide(Config.layerTest(process.cwd(), { prefix: "goat-cloud-hub-proof-" })),
  Layer.provide(FetchHttpClient.layer),
  Layer.provide(NodeServices.layer),
);

it.effect(
  "signed Connect mint grants hub access only under consent and rejects mismatched and replayed proofs",
  () =>
    Effect.gen(function* () {
      const cloud = yield* CloudLink.CloudLink;
      const auth = yield* Auth.EnvironmentAuth;
      const sessions = yield* Sessions.SessionStore;
      const settings = yield* Settings.ServerSettingsService;
      const environment = yield* Environment.ServerEnvironmentIdentity;
      const id = yield* environment.getEnvironmentId;
      const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ed25519");
      const key = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
      yield* cloud.applyRelayConfig({
        connectAuthPolicyVersion: 1,
        relayUrl: "https://relay.test",
        cloudUserId: "account",
        environmentCredential: "environment-credential",
        cloudMintPublicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
        endpointRuntime: null,
      });
      yield* settings.start;
      const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
      let sequence = 0;
      const proof = (overrides: Readonly<Record<string, unknown>> = {}) =>
        signRelayJwt({
          privateKey: key,
          typ: RELAY_MINT_REQUEST_TYP,
          payload: {
            connectAuthPolicyVersion: 1,
            assurance: {
              policyVersion: 1,
              source: "clerk-session",
              userId: "account",
              sessionId: "session",
              firstVerifiedAtFloor: Math.max(0, now - 60),
              secondVerifiedAtFloor: Math.max(0, now - 60),
              checkedAt: now,
              authGeneration: 1,
            },
            iss: "https://relay.test",
            aud: `goat-env:${id}`,
            sub: "account",
            environmentId: id,
            jti: `request-${++sequence}`,
            nonce: `nonce-${sequence}`,
            iat: now,
            exp: now + 60,
            clientProofKeyThumbprint: "device-key",
            cnf: { jkt: "device-key" },
            scope: ["environment:connect"],
            ...overrides,
          },
        });
      for (const [enabled, consent, allowed] of [
        [false, true, false],
        [true, false, false],
        [true, true, true],
      ] as const) {
        yield* settings.updateSettings({ hub: { enabled, connectDevicesHubProxy: consent } });
        const signed = yield* proof();
        const minted = yield* cloud.mintCredential({ proof: signed });
        const exchanged = yield* auth.exchangeBootstrapCredentialForAccessToken(
          minted.credential,
          undefined,
          { deviceType: "mobile" },
          { proofKeyThumbprint: "device-key" },
        );
        expect((yield* sessions.verify(exchanged.access_token)).scopes).toEqual(
          allowed ? [...AuthStandardClientScopes, AuthHubProxyScope] : AuthStandardClientScopes,
        );
        expect(yield* cloud.mintCredential({ proof: signed }).pipe(Effect.result)).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "CloudLinkProofReplayedError" },
        });
      }
      for (const overrides of [
        { sub: "other-account" },
        { environmentId: "other-environment" },
        { cnf: { jkt: "other-key" } },
        { exp: now - 1 },
        { exp: now + 3600 },
      ]) {
        expect(
          yield* cloud.mintCredential({ proof: yield* proof(overrides) }).pipe(Effect.result),
        ).toMatchObject({ _tag: "Failure", failure: { _tag: "CloudLinkProofRejectedError" } });
      }
    }).pipe(Effect.provide(layer)),
);
