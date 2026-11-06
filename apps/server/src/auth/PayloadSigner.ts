// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect 4.0.5 has no HMAC or timing-safe comparison.
import * as NodeCrypto from "node:crypto";

export function signPayload(payload: string, secret: Uint8Array): string {
  return NodeCrypto.createHmac("sha256", Buffer.from(secret)).update(payload).digest("base64url");
}

export function timingSafeEqualBase64Url(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left, "base64url");
  const rightBuffer = Buffer.from(right, "base64url");
  return (
    leftBuffer.length === rightBuffer.length && NodeCrypto.timingSafeEqual(leftBuffer, rightBuffer)
  );
}

export interface PayloadSigner {
  readonly sign: (payload: string) => string;
  readonly verify: (payload: string, signature: string) => boolean;
}

export function fromSecret(secret: Uint8Array): PayloadSigner {
  return {
    sign: (payload) => signPayload(payload, secret),
    verify: (payload, signature) =>
      timingSafeEqualBase64Url(signature, signPayload(payload, secret)),
  };
}
