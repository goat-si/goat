// @effect-diagnostics-next-line nodeBuiltinImport:off -- Signed relay/host boundary fixtures.
import * as NodeCrypto from "node:crypto";
import type {
  RelayEnvironmentLinkProofPayload,
  RelayEnvironmentLinkRequest,
} from "@goat/contracts/relay";
import { RELAY_LINK_PROOF_TYP } from "@goat/shared/relayJwt";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as RelayConfiguration from "../Config.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
const relayKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
export const environmentKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
export const config = RelayConfiguration.RelayConfiguration.of({
  relayIssuer: "https://relay.example.test",
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
  cloudMintPrivateKey: Redacted.make(relayKeyPair.privateKey),
  cloudMintPublicKey: relayKeyPair.publicKey,
  managedEndpointBaseDomain: undefined,
  managedEndpointNamespace: undefined,
});

// Account access needs a subject digest, which requires both of these; unit fixtures stay without them.
export const postgresConfig = RelayConfiguration.RelayConfiguration.of({
  ...config,
  subjectDigestKey: Redacted.make("connect-postgres-subject-digest-key-32-bytes"),
  managedEndpointNamespace: "test",
});

export function signTestJwt(payload: object, typ: string, privateKey: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${encodedPayload}`;
  return `${signingInput}.${NodeCrypto.sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

export const makeAssurance = (now: number) => ({
  policyVersion: 1 as const,
  source: "clerk-session" as const,
  userId: "user_123",
  sessionId: "session-1",
  firstVerifiedAtFloor: Math.max(0, now - 60),
  secondVerifiedAtFloor: Math.max(0, now - 60),
  checkedAt: now,
  authGeneration: 1,
});
export const intent = {
  connectAuthPolicyVersion: 1 as const,
  environmentId: "env-link-test",
  environmentPublicKey: environmentKeyPair.publicKey.trim(),
  origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
  notificationsEnabled: false as const,
  liveActivitiesEnabled: false as const,
  managedTunnelsEnabled: false,
};
export const makeRequest = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const expiresAt = DateTime.add(now, { minutes: 5 });
  const relayTokens = yield* RelayTokens.RelayTokens;
  const challenge = yield* relayTokens.issueLinkChallenge({
    assurance: makeAssurance(Math.floor(now.epochMilliseconds / 1000)),
    intent,
    userId: "user_123",
    request: {
      notificationsEnabled: false,
      liveActivitiesEnabled: false,
      managedTunnelsEnabled: true,
    },
    jti: "challenge-jti",
    issuedAtEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
    expiresAtEpochSeconds: Math.floor(expiresAt.epochMilliseconds / 1_000),
  });
  const payload = {
    iss: "goat-env:env-link-test",
    aud: "https://relay.example.test",
    sub: "env-link-test",
    jti: "link-proof-jti",
    iat: Math.floor(now.epochMilliseconds / 1_000),
    exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
    challenge,
    environmentId: "env-link-test" as RelayEnvironmentLinkProofPayload["environmentId"],
    descriptor: {
      connectAuthPolicyVersion: 1,
      environmentId: "env-link-test" as RelayEnvironmentLinkProofPayload["environmentId"],
      label: "Link Test Environment",
      platform: { os: "darwin", arch: "arm64" },
      serverVersion: "0.0.0-test",
      capabilities: { repositoryIdentity: true },
    },
    environmentPublicKey: environmentKeyPair.publicKey.trim(),
    endpoint: {
      httpBaseUrl: "https://env.example.test/",
      wsBaseUrl: "wss://env.example.test/",
      providerKind: "manual",
    },
    origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
    scopes: ["agent_activity_notifications", "managed_tunnels"],
  } satisfies RelayEnvironmentLinkProofPayload;
  return {
    request: {
      proof: signTestJwt(payload, RELAY_LINK_PROOF_TYP, environmentKeyPair.privateKey),
      notificationsEnabled: false,
      liveActivitiesEnabled: false,
      managedTunnelsEnabled: false,
    } satisfies RelayEnvironmentLinkRequest,
    payload,
  };
});
