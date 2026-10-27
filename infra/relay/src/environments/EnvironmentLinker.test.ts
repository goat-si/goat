import { createPostgresFixture } from "../accounts/test/PostgresFixture.ts";
import { postgresPolicyLayer } from "../accounts/test/PolicyPostgresLayers.ts";
import { RelayRateLimits } from "../accounts/RelayRateLimits.ts";
import type { ManagedEndpointAllocation } from "./ManagedEndpointAllocations.ts";
import { policyUnitLayer } from "../accounts/test/PolicyUnitLayers.ts";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto has no generateKeyPairSync or sign.
import * as NodeCrypto from "node:crypto";
import type {
  RelayEnvironmentLinkProofPayload,
  RelayEnvironmentLinkRequest,
} from "@goat/contracts/relay";
import { RELAY_LINK_PROOF_TYP } from "@goat/shared/relayJwt";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as DpopProofs from "../auth/DpopProofs.ts";
import * as RelayTokens from "../auth/RelayTokens.ts";
import * as EnvironmentCredentials from "./EnvironmentCredentials.ts";
import * as EnvironmentLinks from "./EnvironmentLinks.ts";
import * as RelayConfiguration from "../Config.ts";
import * as EnvironmentLinker from "./EnvironmentLinker.ts";
import * as ManagedEndpointProvider from "./ManagedEndpointProvider.ts";

const relayKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const environmentKeyPair = NodeCrypto.generateKeyPairSync("ed25519", {
  privateKeyEncoding: { format: "pem", type: "pkcs8" },
  publicKeyEncoding: { format: "pem", type: "spki" },
});
const config = RelayConfiguration.RelayConfiguration.of({
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
const isEnvironmentLinkProofInvalid = Schema.is(EnvironmentLinker.EnvironmentLinkProofInvalid);

function signTestJwt(payload: object, typ: string, privateKey: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "EdDSA", typ })).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signingInput = `${header}.${encodedPayload}`;
  return `${signingInput}.${NodeCrypto.sign(null, Buffer.from(signingInput), privateKey).toString("base64url")}`;
}

const makeRequest = Effect.gen(function* () {
  const now = yield* DateTime.now;
  const expiresAt = DateTime.add(now, { minutes: 5 });
  const relayTokens = yield* RelayTokens.RelayTokens;
  const challenge = yield* relayTokens.issueLinkChallenge({
    userId: "user_123",
    request: {
      notificationsEnabled: true,
      liveActivitiesEnabled: true,
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
      notificationsEnabled: true,
      liveActivitiesEnabled: true,
      managedTunnelsEnabled: false,
    } satisfies RelayEnvironmentLinkRequest,
    payload,
  };
});

function layerTest(input?: {
  readonly provision?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["provision"];
  readonly prepareDeprovision?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["prepareDeprovision"];
  readonly upsert?: EnvironmentLinks.EnvironmentLinks["Service"]["upsert"];
  readonly consume?: DpopProofs.DpopProofReplay["Service"]["consume"];
  readonly deprovision?: ManagedEndpointProvider.ManagedEndpointProvider["Service"]["deprovision"];
}) {
  return EnvironmentLinker.layer.pipe(
    Layer.provide(policyUnitLayer),
    Layer.provideMerge(RelayTokens.layer.pipe(Layer.provide(policyUnitLayer))),
    Layer.provide(
      Layer.mergeAll(
        RelayConfiguration.layer(config),
        Layer.succeed(DpopProofs.DpopProofReplay, {
          verifyAndConsume: () => Effect.die("unexpected DPoP proof verification"),
          consume: input?.consume ?? (() => Effect.succeed(true)),
          pruneExpired: Effect.void,
        }),
        Layer.succeed(EnvironmentLinks.EnvironmentLinks, {
          upsert: input?.upsert ?? (() => Effect.void),
          listDeliveryUsersForEnvironment: () => Effect.succeed([]),
          listForUser: () => Effect.succeed([]),
          getForUser: () => Effect.succeed(null),
          findActiveManagedForEnvironment: () => Effect.succeed([]),
          setHoldWebhooksWhileOffline: () => Effect.void,
          revokeForUser: () => Effect.succeed(false),
        }),
        Layer.succeed(EnvironmentCredentials.EnvironmentCredentials, {
          create: () => Effect.succeed("goatenv_credential_secret"),
          authenticate: () => Effect.succeedNone,
          revokeForEnvironmentPublicKey: () => Effect.succeed(false),
        }),
        Layer.succeed(ManagedEndpointProvider.ManagedEndpointProvider, {
          reconcileOrigin: () => Effect.succeed("ready"),
          prepareDeprovision: input?.prepareDeprovision ?? (() => Effect.succeed(null)),
          deprovision: input?.deprovision ?? (() => Effect.succeed(true)),
          release: () => Effect.succeed(true),
          provision:
            input?.provision ??
            (() =>
              Effect.succeed({
                endpoint: {
                  httpBaseUrl: "https://managed.example.test/",
                  wsBaseUrl: "wss://managed.example.test/ws",
                  providerKind: "cloudflare_tunnel",
                },
                runtime: { providerKind: "cloudflare_tunnel", connectorToken: "connector-token" },
              })),
        }),
      ),
    ),
  );
}

describe("EnvironmentLinker", () => {
  it.effect("uses verified JWT claims when linking an environment", () => {
    let persistedEnvironmentId: string | null = null;
    return Effect.gen(function* () {
      const { request, payload } = yield* makeRequest;
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const result = yield* linker.link({ userId: "user_123", request });
      expect(result.environmentId).toBe(payload.environmentId);
      expect(result.environmentCredential).toBe("goatenv_credential_secret");
      expect(persistedEnvironmentId).toBe(payload.environmentId);
    }).pipe(
      Effect.provide(
        layerTest({
          upsert: (input) =>
            Effect.sync(() => {
              persistedEnvironmentId = input.proof.environmentId;
            }),
        }),
      ),
    );
  });

  it.effect("links a publish-only environment with a non-secure nominal endpoint", () => {
    let persistedEndpoint: string | null = null;
    let deprovisionedEnvironmentId: string | null = null;
    return Effect.gen(function* () {
      const now = yield* DateTime.now;
      const expiresAt = DateTime.add(now, { minutes: 5 });
      const relayTokens = yield* RelayTokens.RelayTokens;
      const challenge = yield* relayTokens.issueLinkChallenge({
        userId: "user_123",
        request: {
          notificationsEnabled: true,
          liveActivitiesEnabled: true,
          managedTunnelsEnabled: false,
        },
        jti: "publish-only-challenge-jti",
        issuedAtEpochSeconds: Math.floor(now.epochMilliseconds / 1_000),
        expiresAtEpochSeconds: Math.floor(expiresAt.epochMilliseconds / 1_000),
      });
      const payload = {
        iss: "goat-env:env-link-test",
        aud: "https://relay.example.test",
        sub: "env-link-test",
        jti: "publish-only-proof-jti",
        iat: Math.floor(now.epochMilliseconds / 1_000),
        exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
        challenge,
        environmentId: "env-link-test" as RelayEnvironmentLinkProofPayload["environmentId"],
        descriptor: {
          environmentId: "env-link-test" as RelayEnvironmentLinkProofPayload["environmentId"],
          label: "Link Test Environment",
          platform: { os: "darwin", arch: "arm64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        environmentPublicKey: environmentKeyPair.publicKey.trim(),
        endpoint: {
          httpBaseUrl: "http://127.0.0.1:3773/",
          wsBaseUrl: "ws://127.0.0.1:3773/",
          providerKind: "manual",
        },
        origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
        scopes: ["agent_activity_notifications"],
      } satisfies RelayEnvironmentLinkProofPayload;
      const request = {
        proof: signTestJwt(payload, RELAY_LINK_PROOF_TYP, environmentKeyPair.privateKey),
        notificationsEnabled: true,
        liveActivitiesEnabled: true,
        managedTunnelsEnabled: false,
      } satisfies RelayEnvironmentLinkRequest;
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const result = yield* linker.link({ userId: "user_123", request });
      expect(result.environmentCredential).toBe("goatenv_credential_secret");
      expect(result.endpointRuntime).toBeNull();
      expect(persistedEndpoint).toBe("http://127.0.0.1:3773/");
      expect(deprovisionedEnvironmentId).toBe("env-link-test");
    }).pipe(
      Effect.provide(
        layerTest({
          upsert: (input) =>
            Effect.sync(() => {
              persistedEndpoint = input.endpoint.httpBaseUrl;
            }),
          deprovision: (input) =>
            Effect.sync(() => {
              deprovisionedEnvironmentId = input.environmentId;
              return true;
            }),
        }),
      ),
    );
  });

  it.effect("rejects a tampered compact proof before persistence", () => {
    let persisted = false;
    return Effect.gen(function* () {
      const { request } = yield* makeRequest;
      const segments = request.proof.split(".");
      const signature = segments[2]!;
      segments[2] = `${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}`;
      const tampered = { ...request, proof: segments.join(".") };
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const result = yield* Effect.result(linker.link({ userId: "user_123", request: tampered }));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentLinkProofInvalid(result.failure)).toBe(true);
        if (isEnvironmentLinkProofInvalid(result.failure)) {
          expect(result.failure).toMatchObject({
            userId: "user_123",
            environmentId: "env-link-test",
            reason: "invalid_signature_or_scope",
            stage: "verify_proof",
            cause: { _tag: "RelayJwtError" },
          });
        }
      }
      expect(persisted).toBe(false);
    }).pipe(
      Effect.provide(
        layerTest({
          upsert: () =>
            Effect.sync(() => {
              persisted = true;
            }),
        }),
      ),
    );
  });

  it.effect("rejects replayed JWT ids", () =>
    Effect.gen(function* () {
      const { request } = yield* makeRequest;
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const result = yield* Effect.result(linker.link({ userId: "user_123", request }));
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(isEnvironmentLinkProofInvalid(result.failure)).toBe(true);
        if (isEnvironmentLinkProofInvalid(result.failure)) {
          expect(result.failure).toMatchObject({
            userId: "user_123",
            environmentId: "env-link-test",
            reason: "replayed_nonce",
            stage: "consume_proof_nonce",
          });
        }
      }
    }).pipe(Effect.provide(layerTest({ consume: () => Effect.succeed(false) }))),
  );
});

it.effect.each([true, false])(
  "failed finalization compensates only the captured allocation (matching=%s)",
  (matching) => {
    let removed: ManagedEndpointAllocation | undefined;
    const target: ManagedEndpointAllocation = {
      userId: "user_123",
      environmentId: "env-link-test",
      incarnationId: "10000000-0000-4000-8000-000000000001",
      accountEpoch: 1,
      endpointGeneration: 0,
      capacityReleasedAt: null,
      hostname: "managed.example.test",
      tunnelId: "fixture-tunnel",
      tunnelName: "fixture-name",
      dnsRecordId: "fixture-dns",
      readyAt: "1970-01-01T00:00:00.000Z",
      origin: { localHttpHost: "127.0.0.1", localHttpPort: 3773 },
      updatedAt: "1970-01-01T00:00:00.000Z",
      generation: 3,
      tunnelReleasedAt: null,
    };
    return Effect.gen(function* () {
      const { request } = yield* makeRequest;
      const linker = yield* EnvironmentLinker.EnvironmentLinker;
      const failure = yield* Effect.flip(
        linker.link({ userId: "user_123", request: { ...request, managedTunnelsEnabled: true } }),
      );
      expect(failure._tag).toBe("EnvironmentLinkUpsertPersistenceError");
      expect(removed?.generation).toBe(matching ? 3 : undefined);
    }).pipe(
      Effect.provide(
        layerTest({
          upsert: () =>
            Effect.fail(
              new EnvironmentLinks.EnvironmentLinkUpsertPersistenceError({
                userId: "user_123",
                environmentId: "env-link-test",
                cause: new Error("fixture finalization failure"),
              }),
            ),
          provision: () =>
            Effect.succeed({
              endpoint: {
                httpBaseUrl: "https://managed.example.test/",
                wsBaseUrl: "wss://managed.example.test/ws",
                providerKind: "cloudflare_tunnel",
              },
              runtime: { providerKind: "cloudflare_tunnel", connectorToken: "fixture-connector" },
              allocationClaim: {
                incarnationId: target.incarnationId,
                generation: 3,
                accountEpoch: 1,
                endpointGeneration: 0,
                tunnelId: "fixture-tunnel",
              },
            }),
          prepareDeprovision: () => Effect.succeed({ ...target, generation: matching ? 3 : 4 }),
          deprovision: (input) =>
            Effect.sync(() => {
              removed = input.target ?? undefined;
              return true;
            }),
        }),
      ),
    );
  },
);

it.live(
  "a credential insert failure rolls back the link and owner activation in the actual signed-link service",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      pg.query(
        "INSERT INTO relay_account_access(user_id,status,account_epoch) VALUES ('user_123','allowed',1)",
      );
      pg.query(
        "CREATE FUNCTION reject_fixture_credentials() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture credential outage'; END $$; CREATE TRIGGER reject_fixture_credentials BEFORE INSERT ON relay_environment_credentials FOR EACH ROW EXECUTE FUNCTION reject_fixture_credentials()",
      );
      const policy = postgresPolicyLayer(pg);
      const rates = Layer.succeed(RelayRateLimits, { charge: () => Effect.void });
      const configuration = RelayConfiguration.layer(config);
      const tokens = RelayTokens.layer.pipe(
        Layer.provide(configuration),
        Layer.provide(rates),
        Layer.provide(policy),
      );
      const runtime = EnvironmentLinker.layer.pipe(
        Layer.provide(
          Layer.mock(ManagedEndpointProvider.ManagedEndpointProvider, {
            deprovision: () => Effect.succeed(true),
          }),
        ),
        Layer.provide(DpopProofs.layer.pipe(Layer.provide(policy))),
        Layer.provideMerge(tokens),
        Layer.provide(configuration),
        Layer.provide(rates),
        Layer.provide(policy),
      );
      yield* Effect.gen(function* () {
        const { request } = yield* makeRequest;
        const linker = yield* EnvironmentLinker.EnvironmentLinker;
        const result = yield* linker.link({ userId: "user_123", request }).pipe(Effect.result);
        expect(result).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "EnvironmentCredentialCreatePersistenceError" },
        });
        expect(pg.query("SELECT count(*) FROM relay_environment_links").trim()).toBe("0");
        expect(pg.query("SELECT count(*) FROM relay_environment_credentials").trim()).toBe("0");
        expect(pg.query("SELECT state FROM relay_environment_owners").trim()).toBe("pending");
      }).pipe(Effect.provide(runtime));
    }),
);
