import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Generates an Ed25519 key pair for a token fixture.
import * as NodeCrypto from "node:crypto";

import {
  makeRelayJwtSigner,
  makeRelayJwtVerifier,
  RelayJwtError,
  verifyRelayJwt,
} from "./relayJwt.ts";

describe("relayJwt", () => {
  it.effect(
    "holder-signed tokens remain compatible with relay verification and reject the wrong audience",
    () =>
      Effect.gen(function* () {
        const keys = NodeCrypto.generateKeyPairSync("ed25519", {
          privateKeyEncoding: { format: "pem", type: "pkcs8" },
          publicKeyEncoding: { format: "pem", type: "spki" },
        });
        const sign = makeRelayJwtSigner(keys.privateKey);
        const verify = makeRelayJwtVerifier(keys.publicKey);
        const input = {
          typ: "goat-test+jwt",
          issuer: "issuer",
          audience: "audience",
          nowEpochSeconds: 1_700_000_000,
        };
        for (const jti of ["one", "two"]) {
          const token = yield* sign({
            typ: input.typ,
            payload: { iss: input.issuer, aud: input.audience, iat: input.nowEpochSeconds, jti },
          });
          expect((yield* verify({ ...input, token })).jti).toBe(jti);
          expect((yield* verifyRelayJwt({ ...input, token, publicKey: keys.publicKey })).jti).toBe(
            jti,
          );
          expect((yield* Effect.result(verify({ ...input, token, audience: "wrong" })))._tag).toBe(
            "Failure",
          );
        }
      }),
  );
  it("extracts stable diagnostic codes without copying cause text into the error message", () => {
    const error = new RelayJwtError({
      operation: "verify",
      typ: "test+jwt",
      cause: { code: "ERR_JWT_EXPIRED", message: "sensitive library detail" },
    });

    expect(RelayJwtError.diagnosticCode(error)).toBe("ERR_JWT_EXPIRED");
    expect(error.message).not.toContain("sensitive library detail");
  });
});
