import { normalizeDpopHtu, type DpopPublicJwk } from "@goat/shared/dpopCommon";
import * as Clock from "effect/Clock";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";

export const createProof = Effect.fn("DpopProof.createProof")(function* <E>(input: {
  readonly method: string;
  readonly url: string;
  readonly accessToken?: string | undefined;
  readonly publicJwk: DpopPublicJwk;
  readonly sign: (bytes: Uint8Array) => Effect.Effect<Uint8Array, E, Crypto.Crypto>;
  readonly error: (message: string, cause?: unknown) => E;
}) {
  const htu = normalizeDpopHtu(input.url);
  if (htu === null) return yield* Effect.fail(input.error("DPoP URL is invalid."));
  const crypto = yield* Crypto.Crypto;
  const jti = yield* crypto
    .randomUUIDv4()
    .pipe(
      Effect.mapError((cause) => input.error("Could not generate DPoP proof identifier.", cause)),
    );
  const now = yield* Clock.currentTimeMillis;
  const ath = input.accessToken
    ? yield* crypto.digest("SHA-256", new TextEncoder().encode(input.accessToken)).pipe(
        Effect.map(Base64Url.encode),
        Effect.mapError((cause) => input.error("Could not hash the DPoP access token.", cause)),
      )
    : undefined;
  const encode = (value: object) =>
    Base64Url.encode(new TextEncoder().encode(JSON.stringify(value)));
  const header = encode({ typ: "dpop+jwt", alg: "ES256", jwk: input.publicJwk });
  const payload = encode({
    htm: input.method.toUpperCase(),
    htu,
    jti,
    iat: Math.floor(now / 1_000),
    ...(ath ? { ath } : {}),
  });
  const unsigned = `${header}.${payload}`;
  const signature = yield* input.sign(new TextEncoder().encode(unsigned));
  return `${unsigned}.${Base64Url.encode(signature)}`;
});
