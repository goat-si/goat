// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect 4.0.5 has no AES, HKDF or HMAC.
import * as NodeCrypto from "node:crypto";

import { base64UrlDecodeUtf8 } from "../auth/utils.ts";

const SEALED_PREFIX = "s1";
const IV_BYTES = 16;

const sealKeys = (secret: Uint8Array) => {
  const keys = Buffer.from(
    NodeCrypto.hkdfSync("sha256", secret, new Uint8Array(0), "goat/asset-claims/seal/v1", 64),
  );
  return { ivKey: keys.subarray(0, 32), encryptionKey: keys.subarray(32) };
};

const syntheticIv = (ivKey: Buffer, json: Buffer) =>
  NodeCrypto.createHmac("sha256", ivKey).update(json).digest().subarray(0, IV_BYTES);

/**
 * Encrypts asset claims so a URL never reveals the paths they name. The IV derives from the
 * claims, so equal claims keep one stable URL; the caller still signs the sealed payload.
 */
export function sealAssetClaims(json: string, secret: Uint8Array): string {
  const { ivKey, encryptionKey } = sealKeys(secret);
  const plaintext = Buffer.from(json, "utf8");
  const iv = syntheticIv(ivKey, plaintext);
  const cipher = NodeCrypto.createCipheriv("aes-256-ctr", encryptionKey, iv);
  const sealed = Buffer.concat([iv, cipher.update(plaintext), cipher.final()]);
  return `${SEALED_PREFIX}${sealed.toString("base64url")}`;
}

/**
 * Returns the claims JSON of a verified payload, or null. Payloads minted before sealing are
 * plain base64url JSON and stay readable until they expire, at most 90 minutes after upgrade.
 */
export function openAssetClaims(payload: string, secret: Uint8Array): string | null {
  try {
    if (!payload.startsWith(SEALED_PREFIX)) return base64UrlDecodeUtf8(payload);
    const sealed = Buffer.from(payload.slice(SEALED_PREFIX.length), "base64url");
    if (sealed.length <= IV_BYTES) return null;
    const { ivKey, encryptionKey } = sealKeys(secret);
    const iv = sealed.subarray(0, IV_BYTES);
    const decipher = NodeCrypto.createDecipheriv("aes-256-ctr", encryptionKey, iv);
    const plaintext = Buffer.concat([decipher.update(sealed.subarray(IV_BYTES)), decipher.final()]);
    return NodeCrypto.timingSafeEqual(iv, syntheticIv(ivKey, plaintext))
      ? plaintext.toString("utf8")
      : null;
  } catch {
    return null;
  }
}
