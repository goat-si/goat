// @effect-diagnostics nodeBuiltinImport:off -- Worker-compatible credential hashing matches EnvironmentCredentials.
import { createHash } from "node:crypto";
import { RelayHostRevocationProof } from "@goat/contracts/relay";
import {
  RelayAuthInvalidError,
  RelayAuthorizationUnavailableError,
} from "@goat/contracts/relayErrors";
import { verifyRelayJwt, normalizeRelayIssuer } from "@goat/shared/relayJwt";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { RelayDb } from "../db.ts";
import { RelayConfiguration } from "../Config.ts";
import { DpopProofReplay } from "../auth/DpopProofs.ts";
import { hostTargetDigest } from "./AccountErasure.ts";
import { receiptId } from "./SubjectDigest.ts";

type Input = {
  readonly environmentId: string;
  readonly credential: string;
  readonly environmentPublicKey: string;
  readonly proof: string;
  readonly revocationId?: string;
};
type Error = RelayAuthInvalidError | RelayAuthorizationUnavailableError;
export class HostRevocations extends Context.Service<
  HostRevocations,
  {
    readonly check: (
      input: Input,
    ) => Effect.Effect<
      { revocationId: string; reason: "account_deleted"; action: "unlink" },
      Error
    >;
    readonly acknowledge: (
      input: Input & { readonly revocationId: string },
    ) => Effect.Effect<void, Error>;
  }
>()("goat-relay/accounts/HostRevocations") {}
const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration;
  const db = yield* RelayDb;
  const sql = db.$client;
  const replay = yield* DpopProofReplay;
  const invalid = () =>
    new RelayAuthInvalidError({ code: "auth_invalid", reason: "not_authorized", traceId: "relay" });
  const unavailable = () =>
    new RelayAuthorizationUnavailableError({ code: "authorization_unavailable", traceId: "relay" });
  const verify = Effect.fn("HostRevocations.verify")(function* (
    input: Input,
    action: "unlink" | "ack",
  ) {
    const origin = normalizeRelayIssuer(config.relayIssuer);
    const credential = createHash("sha256").update(input.credential).digest("base64url");
    const target = hostTargetDigest(input.environmentId, input.environmentPublicKey);
    const now = yield* DateTime.now;
    const seconds = Math.floor(now.epochMilliseconds / 1000);
    const path = `/v1/environments/${encodeURIComponent(input.environmentId)}/cloud-revocation${action === "ack" ? "/ack" : ""}`;
    const proof = yield* verifyRelayJwt({
      publicKey: input.environmentPublicKey,
      token: input.proof,
      typ: "goat-host-revocation+jwt",
      issuer: `goat-env:${input.environmentId}`,
      audience: origin,
      nowEpochSeconds: seconds,
      maxTokenAge: "1 minute",
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(RelayHostRevocationProof)),
      Effect.mapError(invalid),
    );
    if (
      proof.sub !== input.environmentId ||
      proof.path !== path ||
      proof.action !== action ||
      proof.credentialDigest !== credential ||
      proof.revocationId !== input.revocationId ||
      proof.exp - proof.iat > 60 ||
      proof.iat > seconds ||
      !proof.jti
    )
      return yield* invalid();
    const id = yield* receiptId(credential, target).pipe(
      Effect.provideService(RelayConfiguration, config),
    );
    if (action === "ack" && input.revocationId !== id) return yield* invalid();
    if (
      !(yield* replay
        .consume({
          thumbprint: `host-revocation:${target}`,
          jti: proof.jti,
          iat: proof.iat,
          expiresAt: DateTime.makeUnsafe(proof.exp * 1000),
        })
        .pipe(Effect.mapError(unavailable)))
    )
      return yield* invalid();
    return { credential, target, id };
  });
  return HostRevocations.of({
    check: Effect.fn("HostRevocations.check")(function* (input) {
      const binding = yield* verify(input, "unlink");
      const [row] = yield* sql<{
        id: string;
      }>`SELECT id FROM relay_host_revocations WHERE id=${binding.id} AND credential_digest=${binding.credential} AND target_digest=${binding.target}`.pipe(
        Effect.mapError(unavailable),
      );
      if (!row) return yield* invalid();
      return { revocationId: row.id, reason: "account_deleted", action: "unlink" };
    }),
    acknowledge: Effect.fn("HostRevocations.acknowledge")(function* (input) {
      const binding = yield* verify(input, "ack");
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const [receipt] = yield* sql<{
              subject_digest: string;
            }>`SELECT subject_digest FROM relay_host_revocations WHERE id=${binding.id}`;
            // A deterministic bound id permits a safe terminal retry after receipt removal or result expiry.
            if (!receipt) return;
            yield* sql`SELECT pg_advisory_xact_lock(hashtextextended(${`relay:account:${receipt.subject_digest}`},0))`;
            const removed =
              yield* sql`DELETE FROM relay_host_revocations WHERE subject_digest=${receipt.subject_digest} AND target_digest=${binding.target} RETURNING id`;
            if (removed.length)
              yield* sql`UPDATE relay_account_operations SET host_acknowledged=host_acknowledged+1 WHERE subject_digest=${receipt.subject_digest} AND kind='delete'`;
          }),
        )
        .pipe(Effect.mapError(unavailable));
    }),
  });
});
export const layer = Layer.effect(HostRevocations, make);
