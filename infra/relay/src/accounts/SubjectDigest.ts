// @effect-diagnostics nodeBuiltinImport:off -- Worker-compatible HMAC keeps denial lookup independent of mint-key rotation.
import { createHmac } from "node:crypto";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { RelayAuthorizationUnavailableError } from "@goat/contracts/relayErrors";
import { RelayConfiguration } from "../Config.ts";

export const subjectDigest = Effect.fn("SubjectDigest.subject")(function* (userId: string) {
  const config = yield* RelayConfiguration;
  if (
    !config.subjectDigestKey ||
    Redacted.value(config.subjectDigestKey).length < 32 ||
    !config.managedEndpointNamespace
  )
    return yield* new RelayAuthorizationUnavailableError({
      code: "authorization_unavailable",
      traceId: "relay",
    });
  return createHmac("sha256", Redacted.value(config.subjectDigestKey))
    .update(`${config.managedEndpointNamespace}:${userId}`)
    .digest("hex");
});
export const receiptId = Effect.fn("SubjectDigest.receipt")(function* (
  credential: string,
  target: string,
) {
  const config = yield* RelayConfiguration;
  if (!config.subjectDigestKey || Redacted.value(config.subjectDigestKey).length < 32)
    return yield* new RelayAuthorizationUnavailableError({
      code: "authorization_unavailable",
      traceId: "relay",
    });
  return createHmac("sha256", Redacted.value(config.subjectDigestKey))
    .update(`goat-host-revocation:v1:${credential}:${target}`)
    .digest("hex");
});
