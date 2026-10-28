import { RelayHostRevocationReceipt } from "@goat/contracts/relay";
import { signRelayJwt, normalizeRelayIssuer } from "@goat/shared/relayJwt";
import { normalizeSecureRelayUrl } from "@goat/shared/relayUrl";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Base64Url from "effect/encoding/Base64Url";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { getOrCreateEnvironmentKeyPairFromSecretStore } from "./environmentKeys.ts";
import { ServerSecretStore } from "../auth/ServerSecretStore.ts";

export class CloudLinkRevocationError extends Schema.TaggedError<CloudLinkRevocationError>()(
  "CloudLinkRevocationError",
  {
    phase: Schema.Literals(["transport", "local_cleanup"]),
    cause: Schema.optional(Schema.Defect()),
    retryAtMillis: Schema.optionalKey(Schema.Number),
  },
) {
  override get message(): string {
    return "GOAT Connect local cleanup has not been confirmed.";
  }
}
const isCloudLinkRevocationError = Schema.is(CloudLinkRevocationError);

export interface CleanupTarget {
  readonly relayUrl: string;
  readonly credential: string;
  readonly environmentId: string;
  readonly revocationId?: string;
}
export const request = Effect.fn("CloudLinkRevocationClient.request")(
  function* (target: CleanupTarget) {
    const client = yield* HttpClient.HttpClient;
    const crypto = yield* Crypto.Crypto;
    const secrets = yield* ServerSecretStore;
    const relay = normalizeSecureRelayUrl(target.relayUrl);
    if (!relay) return yield* new CloudLinkRevocationError({ phase: "transport" });
    const origin = normalizeRelayIssuer(relay);
    const path = `/v1/environments/${encodeURIComponent(target.environmentId)}/cloud-revocation${target.revocationId ? "/ack" : ""}`;
    const key = yield* getOrCreateEnvironmentKeyPairFromSecretStore(secrets);
    const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
    const credentialDigest = yield* crypto
      .digest("SHA-256", new TextEncoder().encode(target.credential))
      .pipe(Effect.map(Base64Url.encode));
    const proof = yield* signRelayJwt({
      privateKey: key.privateKey,
      typ: "goat-host-revocation+jwt",
      payload: {
        iss: `goat-env:${target.environmentId}`,
        aud: origin,
        sub: target.environmentId,
        action: target.revocationId ? "ack" : "unlink",
        path,
        credentialDigest,
        ...(target.revocationId ? { revocationId: target.revocationId } : {}),
        jti: yield* crypto.randomUUIDv4(),
        iat: now,
        exp: now + 60,
      },
    });
    const response = yield* client
      .execute(
        HttpClientRequest.post(`${origin}${path}`).pipe(
          HttpClientRequest.setHeader("authorization", `Bearer ${target.credential}`),
          HttpClientRequest.bodyJsonUnsafe({
            environmentPublicKey: key.publicKey,
            proof,
            ...(target.revocationId ? { revocationId: target.revocationId } : {}),
          }),
        ),
      )
      .pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.timeout("10 seconds"),
      );
    if (response.status !== 200) {
      const header = response.headers["retry-after"];
      const retryAt =
        header === undefined
          ? undefined
          : /^\d+$/u.test(header)
            ? (yield* DateTime.now).epochMilliseconds + Number(header) * 1000
            : Date.parse(header);
      return yield* new CloudLinkRevocationError({
        phase: "transport",
        ...(retryAt !== undefined && Number.isSafeInteger(retryAt)
          ? { retryAtMillis: retryAt }
          : {}),
      });
    }
    if (target.revocationId) return null;
    return yield* HttpClientResponse.schemaBodyJson(RelayHostRevocationReceipt)(response);
  },
  Effect.mapError((cause) =>
    isCloudLinkRevocationError(cause)
      ? cause
      : new CloudLinkRevocationError({ phase: "transport", cause }),
  ),
);
