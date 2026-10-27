// @effect-diagnostics nodeBuiltinImport:off -- Disposable environment signing keys and credential digests.
import { createHash, generateKeyPairSync } from "node:crypto";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as DateTime from "effect/DateTime";
import { signRelayJwt } from "@goat/shared/relayJwt";
import { createPostgresFixture } from "./test/PostgresFixture.ts";
import { postgresPolicyLayer } from "./test/PolicyPostgresLayers.ts";
import { hostTargetDigest } from "./AccountErasure.ts";
import { HostRevocations, layer } from "./HostRevocations.ts";
import * as Dpop from "../auth/DpopProofs.ts";
import { AccountLifecycle } from "./AccountLifecycle.ts";
import { RelayDb } from "../db.ts";
import { subjectDigest, receiptId } from "./SubjectDigest.ts";
import { RelayConfiguration } from "../Config.ts";
import { testConfig } from "./test/PolicyPostgresLayers.ts";

it.live(
  "a supported host can return after 90 days and a lost ack response settles once across restart without acknowledging B",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      const key = generateKeyPairSync("ed25519", {
        privateKeyEncoding: { type: "pkcs8", format: "pem" },
        publicKeyEncoding: { type: "spki", format: "pem" },
      });
      const credential = "fixture-opaque-credential";
      const credentialDigest = createHash("sha256").update(credential).digest("base64url");
      const target = hostTargetDigest("env", key.publicKey);
      let nonce = 0;
      const proof = (ack?: string) =>
        Effect.gen(function* () {
          const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
          return yield* signRelayJwt({
            privateKey: key.privateKey,
            typ: "goat-host-revocation+jwt",
            payload: {
              iss: "goat-env:env",
              aud: testConfig.relayIssuer,
              sub: "env",
              action: ack ? "ack" : "unlink",
              path: `/v1/environments/env/cloud-revocation${ack ? "/ack" : ""}`,
              credentialDigest,
              ...(ack ? { revocationId: ack } : {}),
              jti: `nonce-${++nonce}`,
              iat: now,
              exp: now + 60,
            },
          });
        });
      const setup = postgresPolicyLayer(pg);
      const runtime = layer.pipe(Layer.provideMerge(Dpop.layer), Layer.provideMerge(setup));
      const id = yield* Effect.gen(function* () {
        const lifecycle = yield* AccountLifecycle;
        const op = yield* lifecycle.requestDelete({ userId: "delete-a", idempotencyKey: "delete" });
        if (op.status !== "progress") throw new Error("expected progress");
        const digest = yield* subjectDigest("delete-a").pipe(
          Effect.provideService(RelayConfiguration, testConfig),
        );
        const id = yield* receiptId(credentialDigest, target).pipe(
          Effect.provideService(RelayConfiguration, testConfig),
        );
        const sql = (yield* RelayDb).$client;
        yield* sql`INSERT INTO relay_host_revocations(id,subject_digest,credential_digest,target_digest,created_at) VALUES (${id},${digest},${credentialDigest},${target},now()-interval '91 days')`;
        yield* sql`INSERT INTO relay_host_revocations(id,subject_digest,credential_digest,target_digest) VALUES ('b','b','b','b')`;
        yield* lifecycle.resume(op.operationId);
        const service = yield* HostRevocations;
        expect(
          (yield* service.check({
            environmentId: "env",
            environmentPublicKey: key.publicKey,
            credential,
            proof: yield* proof(),
          })).revocationId,
        ).toBe(id);
        yield* service.acknowledge({
          environmentId: "env",
          environmentPublicKey: key.publicKey,
          credential,
          revocationId: id,
          proof: yield* proof(id),
        });
        expect(
          pg
            .query("SELECT host_acknowledged FROM relay_account_operations WHERE kind='delete'")
            .trim(),
        ).toBe("1");
        return id;
      }).pipe(Effect.provide(runtime));
      yield* Effect.gen(function* () {
        const service = yield* HostRevocations;
        yield* service.acknowledge({
          environmentId: "env",
          environmentPublicKey: key.publicKey,
          credential,
          revocationId: id,
          proof: yield* proof(id),
        });
        expect(
          (yield* Effect.flip(
            service.acknowledge({
              environmentId: "env",
              environmentPublicKey: key.publicKey,
              credential,
              revocationId: "b",
              proof: yield* proof("b"),
            }),
          )).code,
        ).toBe("auth_invalid");
        expect(
          pg
            .query("SELECT host_acknowledged FROM relay_account_operations WHERE kind='delete'")
            .trim(),
        ).toBe("1");
        expect(pg.query("SELECT id FROM relay_host_revocations").trim()).toBe("b");
      }).pipe(Effect.provide(runtime));
    }),
);
