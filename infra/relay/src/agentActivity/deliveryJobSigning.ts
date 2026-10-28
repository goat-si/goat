// @effect-diagnostics nodeBuiltinImport:off -- Worker-compatible node:crypto provides constant-time HMAC verification.
import * as NodeCrypto from "node:crypto";
import * as Redacted from "effect/Redacted";
import { stableStringify } from "@goat/shared/relaySigning";

export function signDeliveryPayload(
  secret: Redacted.Redacted<string>,
  context: "apns-v2" | "fcm-v2",
  payload: unknown,
): string {
  return NodeCrypto.createHmac("sha256", Redacted.value(secret))
    .update(context)
    .update("\0")
    .update(stableStringify(payload))
    .digest("base64url");
}
export function verifyDeliverySignature(
  secret: Redacted.Redacted<string>,
  context: "apns-v2" | "fcm-v2",
  payload: unknown,
  signature: string,
): boolean {
  const expected = Buffer.from(signDeliveryPayload(secret, context, payload), "base64url");
  const actual = Buffer.from(signature, "base64url");
  return actual.length === expected.length && NodeCrypto.timingSafeEqual(actual, expected);
}
