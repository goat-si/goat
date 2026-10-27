import { createPostgresFixture } from "../accounts/test/PostgresFixture.ts";
import { postgresPolicyLayer } from "../accounts/test/PolicyPostgresLayers.ts";
import { RelayRateLimits } from "../accounts/RelayRateLimits.ts";
import { policyUnitLayer } from "../accounts/test/PolicyUnitLayers.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync.
import * as NodeCrypto from "node:crypto";

import { describe, expect, it } from "@effect/vitest";
import { signRelayJwt } from "@goat/shared/relayJwt";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as RelayConfiguration from "../Config.ts";
import * as RelayTokens from "./RelayTokens.ts";

const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});

const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test/",
  apns: {
    environment: "sandbox",
    teamId: "team-id",
    keyId: "key-id",
    privateKey: Redacted.make("private-key"),
    bundleId: "com.t3tools.t3code.dev",
  },
  apnsDeliveryJobSigningSecret: Redacted.make("job-secret"),
  clerkSecretKey: Redacted.make("clerk-secret"),
  clerkPublishableKey: "pk_test_test",
  clerkJwtAudience: "goat-relay",
  cloudMintPrivateKey: Redacted.make(keyPair.privateKey),
  cloudMintPublicKey: keyPair.publicKey,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});

const layer = RelayTokens.layer.pipe(
  Layer.provide(policyUnitLayer),
  Layer.provide(RelayConfiguration.layer(config)),
);

describe("RelayTokens", () => {
  it.effect("issues a user-bound environment link challenge", () =>
    Effect.gen(function* () {
      const relayTokens = yield* RelayTokens.RelayTokens;
      const token = yield* relayTokens.issueLinkChallenge({
        userId: "user_123",
        request: {
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          managedTunnelsEnabled: true,
        },
        jti: "challenge-1",
        issuedAtEpochSeconds: 100,
        expiresAtEpochSeconds: 200,
      });

      expect(
        yield* relayTokens.verifyLinkChallenge({
          token,
          userId: "user_123",
          request: {
            notificationsEnabled: true,
            liveActivitiesEnabled: true,
            managedTunnelsEnabled: true,
          },
          nowEpochSeconds: 150,
        }),
      ).toMatchObject({ sub: "user_123", jti: "challenge-1" });
      expect(
        yield* relayTokens.verifyLinkChallenge({
          token,
          userId: "attacker",
          request: {
            notificationsEnabled: true,
            liveActivitiesEnabled: true,
            managedTunnelsEnabled: true,
          },
          nowEpochSeconds: 150,
        }),
      ).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("issues and verifies DPoP access tokens bound to one proof-key thumbprint", () =>
    Effect.gen(function* () {
      const relayTokens = yield* RelayTokens.RelayTokens;
      const token = yield* relayTokens.issueDpopAccessToken({
        userId: "user_123",
        proofKeyThumbprint: "proof-key-thumbprint",
        jti: "access-token-1",
        issuedAtEpochSeconds: 100,
        expiresAtEpochSeconds: 1_900,
        clientId: "goat-mobile",
        scopes: ["environment:connect", "environment:status", "mobile:registration"],
      });

      expect(
        yield* relayTokens.verifyDpopAccessToken({ token, nowEpochSeconds: 700 }),
      ).toMatchObject({
        sub: "user_123",
        cnf: { jkt: "proof-key-thumbprint" },
        client_id: "goat-mobile",
        scope: ["environment:connect", "environment:status", "mobile:registration"],
      });
      expect(
        yield* relayTokens.verifyDpopAccessToken({ token, nowEpochSeconds: 1_961 }),
      ).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("issues tunnel-only DPoP access tokens to web public clients", () =>
    Effect.gen(function* () {
      const relayTokens = yield* RelayTokens.RelayTokens;
      const token = yield* relayTokens.issueDpopAccessToken({
        userId: "user_123",
        proofKeyThumbprint: "web-proof-key-thumbprint",
        jti: "web-access-token-1",
        issuedAtEpochSeconds: 100,
        expiresAtEpochSeconds: 200,
        clientId: "goat-web",
        scopes: ["environment:connect", "environment:status"],
      });

      expect(
        yield* relayTokens.verifyDpopAccessToken({ token, nowEpochSeconds: 150 }),
      ).toMatchObject({
        client_id: "goat-web",
        scope: ["environment:connect", "environment:status"],
        cnf: { jkt: "web-proof-key-thumbprint" },
      });
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects signed DPoP tokens whose scope is outside the relay policy", () =>
    Effect.gen(function* () {
      const relayTokens = yield* RelayTokens.RelayTokens;
      const token = yield* signRelayJwt({
        privateKey: keyPair.privateKey,
        typ: "goat-relay-dpop-access+jwt",
        payload: {
          iss: "https://relay.example.test",
          aud: "https://relay.example.test",
          sub: "user_123",
          jti: "access-token-invalid-scope",
          iat: 100,
          exp: 200,
          client_id: "goat-mobile",
          scope: "environment:admin",
          cnf: { jkt: "proof-key-thumbprint" },
        },
      });

      expect(yield* relayTokens.verifyDpopAccessToken({ token, nowEpochSeconds: 150 })).toBeNull();
    }).pipe(Effect.provide(layer)),
  );

  it.effect("rejects mobile registration scope on a web public client token", () =>
    Effect.gen(function* () {
      const relayTokens = yield* RelayTokens.RelayTokens;
      const token = yield* signRelayJwt({
        privateKey: keyPair.privateKey,
        typ: "goat-relay-dpop-access+jwt",
        payload: {
          iss: "https://relay.example.test",
          aud: "https://relay.example.test",
          sub: "user_123",
          jti: "web-token-invalid-mobile-scope",
          iat: 100,
          exp: 200,
          client_id: "goat-web",
          scope: "environment:connect mobile:registration",
          cnf: { jkt: "proof-key-thumbprint" },
        },
      });

      expect(yield* relayTokens.verifyDpopAccessToken({ token, nowEpochSeconds: 150 })).toBeNull();
    }).pipe(Effect.provide(layer)),
  );
});

it.live.each(["challenge", "dpop"] as const)(
  "%s issuance denies missing invitations, suspension and an epoch changed during charging",
  (kind) =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      let changeEpoch = false;
      const runtime = RelayTokens.layer.pipe(
        Layer.provide(RelayConfiguration.layer(config)),
        Layer.provide(
          Layer.succeed(RelayRateLimits, {
            charge: () =>
              Effect.sync(() => {
                if (changeEpoch) pg.query("UPDATE relay_account_access SET account_epoch=3");
              }),
          }),
        ),
        Layer.provide(postgresPolicyLayer(pg)),
      );
      yield* Effect.gen(function* () {
        const tokens = yield* RelayTokens.RelayTokens;
        const input = {
          userId: "owner",
          jti: "fixture",
          issuedAtEpochSeconds: 100,
          expiresAtEpochSeconds: 200,
        };
        const issue =
          kind === "challenge"
            ? tokens.issueLinkChallenge({
                ...input,
                request: {
                  notificationsEnabled: true,
                  liveActivitiesEnabled: true,
                  managedTunnelsEnabled: true,
                },
              })
            : tokens.issueDpopAccessToken({
                ...input,
                proofKeyThumbprint: "fixture-key",
                clientId: "goat-web",
                scopes: ["environment:connect"],
              });
        expect(yield* Effect.flip(issue)).toMatchObject({
          _tag: "RelayAccountAccessDeniedError",
          reason: "not_invited",
        });
        pg.query(
          "INSERT INTO relay_account_access(user_id,status,account_epoch) VALUES ('owner','suspended',2)",
        );
        expect(yield* Effect.flip(issue)).toMatchObject({
          _tag: "RelayAccountAccessDeniedError",
          reason: "suspended",
        });
        pg.query("UPDATE relay_account_access SET status='allowed',account_epoch=1");
        changeEpoch = true;
        expect(yield* Effect.flip(issue)).toMatchObject({ _tag: "RelayAccountEpochStaleError" });
        changeEpoch = false;
        expect(typeof (yield* issue)).toBe("string");
      }).pipe(Effect.provide(runtime));
    }),
);
