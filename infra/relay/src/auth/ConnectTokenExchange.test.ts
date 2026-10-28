// @effect-diagnostics-next-line nodeBuiltinImport:off -- JWT fixtures need an Ed25519 keypair.
import * as NodeCrypto from "node:crypto";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import {
  RelayAccessTokenType,
  RelayDpopTokenExchangeGrantType,
  RelayJwtSubjectTokenType,
  type RelayDpopAccessTokenRequest,
} from "@goat/contracts/relay";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as DateTime from "effect/DateTime";
import * as TestClock from "effect/testing/TestClock";
import { policyUnitLayer } from "../accounts/test/PolicyUnitLayers.ts";
import * as RelayConfiguration from "../Config.ts";
import * as ClientKeys from "./ClientKeys.ts";
import * as ConnectAuthentication from "./ConnectAuthentication.ts";
import * as ConnectTokenExchange from "./ConnectTokenExchange.ts";
import * as RelayTokens from "./RelayTokens.ts";
const pair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const config = RelayConfiguration.make({
  relayIssuer: "https://relay.example.test",
  apns: null,
  clerkSecretKey: Redacted.make("test-secret"),
  clerkPublishableKey: "test-publishable-key",
  clerkJwtAudience: "https://relay.example.test",
  apnsDeliveryJobSigningSecret: Redacted.make("test-delivery"),
  cloudMintPrivateKey: Redacted.make(pair.privateKey),
  cloudMintPublicKey: pair.publicKey,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});
const request: RelayDpopAccessTokenRequest = {
  connectAuthPolicyVersion: 1,
  grant_type: RelayDpopTokenExchangeGrantType,
  subject_token: "session-token",
  subject_token_type: RelayJwtSubjectTokenType,
  requested_token_type: RelayAccessTokenType,
  resource: config.relayIssuer,
  client_id: "goat-web",
  scope: "environment:connect environment:status",
};
const NOW = 1800000000;
const assurance = {
  policyVersion: 1 as const,
  source: "clerk-session" as const,
  userId: "user-1",
  sessionId: "session-1",
  firstVerifiedAtFloor: NOW - 60,
  secondVerifiedAtFloor: NOW - 60,
  checkedAt: NOW,
  authGeneration: 4,
};
function layer(denied = false) {
  return ConnectTokenExchange.layer.pipe(
    Layer.provideMerge(RelayTokens.layer),
    Layer.provide(policyUnitLayer),
    Layer.provide(
      Layer.mergeAll(
        RelayConfiguration.layer(config),
        NodeCryptoLayer.layer,
        Layer.mock(ConnectAuthentication.ConnectAuthentication, {
          session: () =>
            denied
              ? Effect.fail(ConnectAuthentication.strengthRequired("mfa_required"))
              : Effect.succeed(assurance),
        }),
        Layer.mock(ClientKeys.ClientKeys, {
          admit: () => Effect.succeed({ authorizedAt: NOW, admissionId: "key-admission-1" }),
        }),
      ),
    ),
  );
}
describe("Connect DPoP exchange", () => {
  it.effect(
    "issues a key-bound token preserving original factor times and authorization generation",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW * 1000);
        const exchange = yield* ConnectTokenExchange.ConnectTokenExchange;
        const tokens = yield* RelayTokens.RelayTokens;
        const response = yield* exchange.exchange(request, "client-key");
        const claims = yield* tokens.verifyDpopAccessToken({
          token: response.access_token,
          nowEpochSeconds: Math.floor((yield* DateTime.now).epochMilliseconds / 1000),
        });
        expect(claims).toMatchObject({
          assurance,
          cnf: { jkt: "client-key" },
          clientKeyAdmissionId: "key-admission-1",
          clientKeyAuthorizedAt: NOW,
        });
      }).pipe(Effect.provide(layer())),
  );
  it.effect("denies legacy protocol, mobile registration and weak session authority", () =>
    Effect.gen(function* () {
      const exchange = yield* ConnectTokenExchange.ConnectTokenExchange;
      expect(
        (yield* exchange
          .exchange(
            {
              grant_type: request.grant_type,
              subject_token: request.subject_token,
              subject_token_type: request.subject_token_type,
              requested_token_type: request.requested_token_type,
              resource: request.resource,
              client_id: request.client_id,
              scope: request.scope,
            },
            "key",
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(
        (yield* exchange
          .exchange({ ...request, client_id: "goat-mobile", scope: "mobile:registration" }, "key")
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
      expect(yield* exchange.exchange(request, "key").pipe(Effect.flip)).toMatchObject({
        code: "authentication_strength_required",
        reason: "mfa_required",
      });
    }).pipe(Effect.provide(layer(true))),
  );
});
