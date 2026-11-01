/// <reference types="node" />

import * as NodeCrypto from "node:crypto";

import { vi } from "vite-plus/test";
import { describe, expect, it } from "@effect/vitest";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import { verifyDpopProof } from "@goat/shared/dpop";

import { createDpopProof, generateDpopProofKeyPair, loadOrCreateDpopProofKeyPair } from "./dpop";
import * as Dpop from "./dpop";

vi.mock("expo-crypto", () => ({
  CryptoDigestAlgorithm: {
    SHA1: "SHA-1",
    SHA256: "SHA-256",
    SHA384: "SHA-384",
    SHA512: "SHA-512",
  },
  getRandomBytes: (byteCount: number) => new Uint8Array(NodeCrypto.randomBytes(byteCount)),
  getRandomBytesAsync: (byteCount: number) =>
    Promise.resolve(new Uint8Array(NodeCrypto.randomBytes(byteCount))),
  digest: (algorithm: string, data: unknown) => {
    if (!(data instanceof Uint8Array)) {
      return Promise.reject(new TypeError("expo-crypto digest data must be a typed array."));
    }
    return Promise.resolve(
      new Uint8Array(NodeCrypto.createHash(algorithm).update(data).digest()).buffer,
    );
  },
}));

const secureStore = new Map<string, string>();
vi.mock("expo-secure-store", () => ({
  getItemAsync: (key: string) => Promise.resolve(secureStore.get(key) ?? null),
  setItemAsync: (key: string, value: string) => {
    secureStore.set(key, value);
    return Promise.resolve();
  },
}));

function proofIat(proof: string): number {
  const payload = proof.split(".")[1];
  if (!payload) {
    throw new Error("Missing DPoP payload.");
  }
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    readonly iat: number;
  };
  return decoded.iat;
}

function proofHtu(proof: string): string {
  const payload = proof.split(".")[1];
  if (!payload) {
    throw new Error("Missing DPoP payload.");
  }
  const decoded = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
    readonly htu: string;
  };
  return decoded.htu;
}

describe("mobile DPoP", () => {
  it.effect("passes typed-array digest input through the Expo Crypto adapter", () =>
    Effect.gen(function* () {
      const crypto = yield* Crypto.Crypto;
      const digest = yield* crypto.digest("SHA-256", new TextEncoder().encode("typed-array"));

      expect(Buffer.from(digest).toString("hex")).toBe(
        NodeCrypto.createHash("sha256").update("typed-array").digest("hex"),
      );
    }).pipe(Effect.provide(Dpop.layer)),
  );

  it.effect("persists and reuses the installation proof key", () =>
    Effect.gen(function* () {
      secureStore.clear();
      const first = yield* loadOrCreateDpopProofKeyPair();
      const second = yield* loadOrCreateDpopProofKeyPair();

      expect(second.thumbprint).toBe(first.thumbprint);
      expect(second.privateJwk).toEqual(first.privateJwk);
    }).pipe(Effect.provide(Dpop.layer)),
  );

  it.effect("rejects malformed persisted proof keys", () =>
    Effect.gen(function* () {
      secureStore.set("goat.cloud.dpop-proof-key", `{"kty":"EC","crv":"P-256","d":42}`);

      const error = yield* loadOrCreateDpopProofKeyPair().pipe(Effect.flip);

      expect(error.message).toBe("Stored DPoP proof key is invalid.");
    }).pipe(Effect.provide(Dpop.layer)),
  );

  it.effect("signs connect and bootstrap proofs with the same ephemeral proof key", () =>
    Effect.gen(function* () {
      const proofKey = yield* generateDpopProofKeyPair();
      const connect = yield* createDpopProof({
        method: "POST",
        url: "https://relay.example.test/v1/environments/env-1/connect",
        accessToken: "clerk-token",
        proofKey,
      });
      const bootstrap = yield* createDpopProof({
        method: "POST",
        url: "https://desktop.example.test/oauth/token",
        proofKey,
      });

      expect(connect.thumbprint).toBe(proofKey.thumbprint);
      expect(bootstrap.thumbprint).toBe(proofKey.thumbprint);
      expect(
        verifyDpopProof({
          proof: connect.proof,
          method: "POST",
          url: "https://relay.example.test/v1/environments/env-1/connect",
          expectedThumbprint: proofKey.thumbprint,
          expectedAccessToken: "clerk-token",
          nowEpochSeconds: proofIat(connect.proof),
        }),
      ).toMatchObject({ ok: true, thumbprint: proofKey.thumbprint });
      expect(
        verifyDpopProof({
          proof: bootstrap.proof,
          method: "POST",
          url: "https://desktop.example.test/oauth/token",
          expectedThumbprint: proofKey.thumbprint,
          nowEpochSeconds: proofIat(bootstrap.proof),
        }),
      ).toMatchObject({ ok: true, thumbprint: proofKey.thumbprint });
    }).pipe(Effect.provide(Dpop.layer)),
  );

  it.effect("signs DPoP proofs with RFC 9449 htu normalization", () =>
    Effect.gen(function* () {
      const proofKey = yield* generateDpopProofKeyPair();
      const proof = yield* createDpopProof({
        method: "POST",
        url: "https://relay.example.test/v1/environments/env-1/connect?debug=1#ignored",
        accessToken: "clerk-token",
        proofKey,
      });

      expect(proofHtu(proof.proof)).toBe(
        "https://relay.example.test/v1/environments/env-1/connect",
      );
      expect(
        verifyDpopProof({
          proof: proof.proof,
          method: "POST",
          url: "https://relay.example.test/v1/environments/env-1/connect?debug=1#ignored",
          expectedThumbprint: proofKey.thumbprint,
          expectedAccessToken: "clerk-token",
          nowEpochSeconds: proofIat(proof.proof),
        }),
      ).toMatchObject({ ok: true });
    }).pipe(Effect.provide(Dpop.layer)),
  );
});

it.effect("a retained secure-store key is explicitly readmitted after fresh MFA sign-in", () =>
  Effect.gen(function* () {
    secureStore.clear();
    const retained = yield* loadOrCreateDpopProofKeyPair();
    const { ManagedRelay } = yield* Effect.promise(() => import("@goat/client-runtime/relay"));
    const ManagedRelayLayer = yield* Effect.promise(() => import("./managedRelayLayer"));
    const { HttpClient, HttpClientResponse } = yield* Effect.promise(() => import("effect/http"));
    const Layer = yield* Effect.promise(() => import("effect/Layer"));
    const freshToken = `${btoa(JSON.stringify({ alg: "none" }))}.${btoa(JSON.stringify({ sub: "account", session: "fresh-mfa" }))}.signature`;
    const seen: string[] = [];
    const clientLayer = ManagedRelayLayer.layer("https://relay.example.test").pipe(
      Layer.provide(Dpop.layer),
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              const verified = verifyDpopProof({
                proof: request.headers.dpop,
                method: request.method,
                url: request.url,
                expectedThumbprint: retained.thumbprint,
                nowEpochSeconds: proofIat(request.headers.dpop ?? ""),
              });
              expect(verified.ok).toBe(true);
              const body =
                request.body._tag === "Uint8Array"
                  ? new URLSearchParams(new TextDecoder().decode(request.body.body))
                  : null;
              expect(body?.get("readmitClientKey")).toBe("true");
              seen.push(body?.get("subject_token") ?? "");
              return HttpClientResponse.fromWeb(
                request,
                body?.get("subject_token") === freshToken
                  ? Response.json({
                      access_token: "admitted",
                      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
                      token_type: "DPoP",
                      expires_in: 1800,
                      scope: "environment:status",
                    })
                  : Response.json(
                      {
                        code: "authentication_strength_required",
                        reason: "reauthentication_required",
                        requiredLevel: "multi_factor",
                        maxAgeSeconds: 600,
                        traceId: "native-readmit",
                      },
                      { status: 403 },
                    ),
              );
            }),
          ),
        ),
      ),
    );
    const denied = yield* ManagedRelay.ManagedRelayClient.pipe(
      Effect.flatMap((client) =>
        client
          .requestKeyReadmission({
            accountId: "account",
            clerkToken: `${btoa("{}")}.${btoa(JSON.stringify({ sub: "account" }))}.signature`,
          })
          .pipe(Effect.result),
      ),
      Effect.provide(clientLayer),
    );
    expect(denied._tag).toBe("Failure");
    yield* ManagedRelay.ManagedRelayClient.pipe(
      Effect.flatMap((client) =>
        client.resetTokenCache.pipe(
          Effect.andThen(
            client.requestKeyReadmission({ accountId: "account", clerkToken: freshToken }),
          ),
        ),
      ),
      Effect.provide(clientLayer),
    );
    expect(seen).toHaveLength(2);
    expect((yield* loadOrCreateDpopProofKeyPair()).thumbprint).toBe(retained.thumbprint);
  }).pipe(Effect.provide(Dpop.layer)),
);

vi.mock("./managedRelayTokenStore", async () => {
  const Effect = await import("effect/Effect");
  return {
    managedRelayAccessTokenStore: {
      load: Effect.succeed([]),
      save: () => Effect.void,
      clear: Effect.void,
    },
  };
});
vi.mock("@goat/shared/goatConnect", async (original) => ({
  ...(await original<typeof import("@goat/shared/goatConnect")>()),
  isGoatConnectEnabled: () => true,
}));
