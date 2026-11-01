import * as ConnectAccounts from "./ConnectAccounts.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- JWT fixtures require an Ed25519 keypair.
import * as NodeCrypto from "node:crypto";
import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Crypto from "effect/Crypto";
import * as RelayConfiguration from "../Config.ts";
import * as DpopProofs from "./DpopProofs.ts";
import * as CliLinkApprovals from "./CliLinkApprovals.ts";

const pair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const NOW = 1800000000;
const config = RelayConfiguration.make({
  relayIssuer: "https://relay.example.test",
  apns: null,
  clerkSecretKey: Redacted.make("test-secret"),
  clerkPublishableKey: "test-key",
  clerkJwtAudience: "test-audience",
  apnsDeliveryJobSigningSecret: Redacted.make("test-delivery"),
  cloudMintPrivateKey: Redacted.make(pair.privateKey),
  cloudMintPublicKey: pair.publicKey,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});
const assurance = {
  policyVersion: 1 as const,
  source: "clerk-session" as const,
  userId: "user-1",
  sessionId: "session-1",
  firstVerifiedAtFloor: NOW - 60,
  secondVerifiedAtFloor: NOW - 60,
  checkedAt: NOW,
  authGeneration: 1,
};
const intent = {
  connectAuthPolicyVersion: 1 as const,
  environmentId: "environment-1",
  environmentPublicKey: "host-key",
  origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
  notificationsEnabled: false as const,
  liveActivitiesEnabled: false as const,
  managedTunnelsEnabled: true,
};
function layer() {
  const consumed = new Set<string>();
  return CliLinkApprovals.layer.pipe(
    Layer.provideMerge(NodeCryptoLayer.layer),
    Layer.provide(
      Layer.succeed(ConnectAccounts.ConnectAccounts, {
        authorize: () => Effect.succeed(1),
        check: () => Effect.succeed(true),
      }),
    ),
    Layer.provide(RelayConfiguration.layer(config)),
    Layer.provide(
      Layer.mock(DpopProofs.DpopProofReplay, {
        consume: (input) =>
          Effect.sync(() => {
            if (consumed.has(input.jti)) return false;
            consumed.add(input.jti);
            return true;
          }),
      }),
    ),
  );
}
const fixture = Effect.gen(function* () {
  yield* TestClock.setTime(NOW * 1000);
  const service = yield* CliLinkApprovals.CliLinkApprovals;
  const crypto = yield* Crypto.Crypto;
  const verifier = "v".repeat(43);
  const approvalChallenge = Base64Url.encode(
    yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  const issued = yield* service.issue(
    { intent, cliKeyThumbprint: "cli-key", approvalChallenge, state: "approval-state" },
    assurance,
  );
  return {
    service,
    input: {
      approval: issued.approval,
      verifier,
      state: "approval-state",
      userId: "user-1",
      thumbprint: "cli-key",
      intent,
    },
  };
});
describe("CLI link approval authority", () => {
  it.effect("authorizes exactly one concurrent consumer and preserves original factor times", () =>
    Effect.gen(function* () {
      const { service, input } = yield* fixture;
      const results = yield* Effect.all(
        [service.consume(input).pipe(Effect.result), service.consume(input).pipe(Effect.result)],
        { concurrency: "unbounded" },
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      const success = results.find((result) => result._tag === "Success");
      expect(success?._tag === "Success" ? success.success : null).toEqual(assurance);
    }).pipe(Effect.provide(layer())),
  );
  it.effect.each([
    { userId: "other-user" },
    { thumbprint: "other-key" },
    { verifier: "x".repeat(43) },
    { state: "other-state" },
    { intent: { ...intent, environmentId: "other-host" } },
    { intent: { ...intent, environmentPublicKey: "other-host-key" } },
    { intent: { ...intent, origin: { ...intent.origin, localHttpPort: 4884 } } },
  ])("denies mismatched account, key, PKCE, state or host binding %j", (override) =>
    Effect.gen(function* () {
      const { service, input } = yield* fixture;
      expect((yield* service.consume({ ...input, ...override }).pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect((yield* service.consume(input)).userId).toBe("user-1");
    }).pipe(Effect.provide(layer())),
  );
  it.effect("expires during OAuth consent and cannot be renewed with stale factor evidence", () =>
    Effect.gen(function* () {
      const { service, input } = yield* fixture;
      yield* TestClock.adjust("120 seconds");
      expect((yield* service.consume(input).pipe(Effect.result))._tag).toBe("Failure");
      yield* TestClock.adjust("480 seconds");
      expect(
        (yield* service
          .issue(
            { intent, cliKeyThumbprint: "cli-key", approvalChallenge: "challenge", state: "state" },
            assurance,
          )
          .pipe(Effect.result))._tag,
      ).toBe("Failure");
    }).pipe(Effect.provide(layer())),
  );
});
