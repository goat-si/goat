// @effect-diagnostics-next-line nodeBuiltinImport:off -- Signed relay proofs exercise the real host consumer.
import * as NodeCrypto from "node:crypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import { EnvironmentId } from "@goat/contracts";
import { signRelayJwt, RELAY_MINT_REQUEST_TYP } from "@goat/shared/relayJwt";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import { HttpClient, HttpServer } from "effect/http";
import * as Config from "../config.ts";
import * as Auth from "../auth/EnvironmentAuth.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Environment from "../environment/ServerEnvironment.ts";
import * as Awareness from "../relay/AgentAwarenessRelay.ts";
import * as CliTokenManager from "./CliTokenManager.ts";
import * as CloudLink from "./CloudLink.ts";
import * as Runtime from "./ManagedEndpointRuntime.ts";
import * as Reachability from "./ConnectReachability.ts";

vi.mock("@goat/shared/goatConnect", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));

const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const environmentId = EnvironmentId.make("host-1");
const layer = CloudLink.layer.pipe(
  Layer.provideMerge(Auth.layer),
  Layer.provideMerge(Layer.mock(CliTokenManager.CloudCliTokenManager, {})),
  Layer.provideMerge(Secrets.layer),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(
    Layer.mock(Environment.ServerEnvironment, { getEnvironmentId: Effect.succeed(environmentId) }),
  ),
  Layer.provideMerge(
    Layer.mock(Environment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
  Layer.provideMerge(
    Layer.mock(Awareness.AgentAwarenessRelay, { requestCatchUp: () => Effect.void }),
  ),
  Layer.provideMerge(
    Layer.mock(Runtime.CloudManagedEndpointRuntime, {
      applyConfig: () => Effect.succeed({ status: "disabled" }),
      withLinkStateLock: (effect) => effect,
    }),
  ),
  Layer.provideMerge(Layer.mock(Reachability.ConnectReachability, { latest: Effect.succeedNone })),
  Layer.provideMerge(
    Layer.mock(HttpServer.HttpServer, {
      address: NetAddress.inetAddressFromIpStringUnsafe("127.0.0.1", 3773),
    }),
  ),
  Layer.provideMerge(
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make(() => Effect.die("Host mint must not call a network authority")),
    ),
  ),
  Layer.provideMerge(Config.layerTest("/", { prefix: "connect-host-auth-" })),
  Layer.provide(NodeServices.layer),
);

it.effect(
  "signed assurance crosses real host mint and bootstrap, while legacy and withdrawn grants fail",
  () =>
    Effect.gen(function* () {
      const link = yield* CloudLink.CloudLink;
      const auth = yield* Auth.EnvironmentAuth;
      const install = {
        connectAuthPolicyVersion: 1 as const,
        relayUrl: "https://relay.example.test",
        cloudUserId: "account",
        environmentCredential: "environment-credential",
        cloudMintPublicKey: keyPair.publicKey,
        endpointRuntime: null,
      };
      yield* link.applyRelayConfig(install);
      const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
      const assurance = {
        policyVersion: 1 as const,
        source: "clerk-session" as const,
        userId: "account",
        sessionId: "session",
        firstVerifiedAtFloor: Math.max(0, now - 60),
        secondVerifiedAtFloor: Math.max(0, now - 60),
        checkedAt: now,
        authGeneration: 1,
      };
      let sequence = 0;
      const mint = (includeAssurance: boolean) =>
        signRelayJwt({
          privateKey: keyPair.privateKey,
          typ: RELAY_MINT_REQUEST_TYP,
          payload: {
            connectAuthPolicyVersion: 1,
            iss: "https://relay.example.test",
            aud: `goat-env:${environmentId}`,
            sub: "account",
            environmentId,
            jti: `mint-${++sequence}`,
            nonce: `nonce-${sequence}`,
            iat: now,
            exp: now + 120,
            scope: ["environment:connect"],
            clientProofKeyThumbprint: "client-key",
            cnf: { jkt: "client-key" },
            ...(includeAssurance ? { assurance } : {}),
          },
        }).pipe(Effect.flatMap((proof) => link.mintCredential({ proof })));
      expect((yield* mint(false).pipe(Effect.result))._tag).toBe("Failure");
      const valid = yield* mint(true);
      const pending = yield* mint(true);
      const token = yield* auth.exchangeBootstrapCredentialForAccessToken(
        valid.credential,
        ["terminal:read"],
        { deviceType: "mobile", os: "iOS", browser: "GOAT", ipAddress: "127.0.0.1" },
        { proofKeyThumbprint: "client-key" },
      );
      expect(token.token_type).toBe("DPoP");
      expect(token.scope).toBe("terminal:read");
      yield* link.unlink();
      yield* link.applyRelayConfig(install);
      expect(
        (yield* auth
          .exchangeBootstrapCredentialForAccessToken(
            pending.credential,
            ["terminal:read"],
            { deviceType: "mobile", os: "iOS", browser: "GOAT", ipAddress: "127.0.0.1" },
            { proofKeyThumbprint: "client-key" },
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(layer), Effect.scoped),
);
