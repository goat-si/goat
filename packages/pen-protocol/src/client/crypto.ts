// The only primitives a Pen client uses, all from noble (no crypto.subtle, which Hermes lacks).
import { chacha20poly1305 } from "@noble/ciphers/chacha";
import { x25519 } from "@noble/curves/ed25519";
import { blake2s } from "@noble/hashes/blake2s";
import { hkdf } from "@noble/hashes/hkdf";
import { hmac } from "@noble/hashes/hmac";
import { sha1 } from "@noble/hashes/legacy";
import { sha256 as nobleSha256 } from "@noble/hashes/sha2";
import { concatBytes, u64le } from "./bytes.ts";
import { PenError } from "./errors.ts";
import { type Random, takeRandom } from "./runtime.ts";

export const KEY_LENGTH = 32;
export const TAG_LENGTH = 16;

export interface KeyPair {
  readonly privateKey: Uint8Array;
  readonly publicKey: Uint8Array;
}

export function x25519PublicKey(privateKey: Uint8Array): Uint8Array {
  return x25519.getPublicKey(privateKey);
}

export function generateX25519(random: Random): KeyPair {
  const privateKey = takeRandom(random, KEY_LENGTH);
  return { privateKey, publicKey: x25519PublicKey(privateKey) };
}

/** X25519; a low-order peer key (all-zero result) or a malformed key is refused. */
export function x25519Shared(privateKey: Uint8Array, publicKey: Uint8Array): Uint8Array {
  if (publicKey.length !== KEY_LENGTH) throw new PenError("dh-invalid", "peer key is not 32 bytes");
  try {
    return x25519.getSharedSecret(privateKey, publicKey);
  } catch (cause) {
    throw new PenError("dh-invalid", "X25519 refused the peer key", { cause });
  }
}

export function blake2sHash(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  return blake2s(concatBytes(...parts));
}

export function hmacBlake2s(key: Uint8Array, ...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  return hmac(blake2s, key, concatBytes(...parts));
}

export function sha256(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  return nobleSha256(concatBytes(...parts));
}

export function hmacSha256(key: Uint8Array, ...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  return hmac(nobleSha256, key, concatBytes(...parts));
}

export function hkdfSha256(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Uint8Array {
  return hkdf(nobleSha256, ikm, salt, info, length);
}

/** SHA-1, only for the WebSocket accept value (RFC 6455 section 4.2.2). */
export function sha1Hash(data: Uint8Array): Uint8Array {
  return sha1(data);
}

/** The Noise ChaChaPoly nonce: 4 zero bytes, then n as 64-bit little-endian. */
function noiseNonce(n: number | "max"): Uint8Array {
  const nonce = new Uint8Array(12);
  if (n === "max") nonce.fill(0xff, 4);
  else nonce.set(u64le(n), 4);
  return nonce;
}

export function aeadSeal(
  key: Uint8Array,
  n: number | "max",
  ad: Uint8Array,
  plaintext: Uint8Array,
): Uint8Array {
  return chacha20poly1305(key, noiseNonce(n), ad).encrypt(plaintext);
}

/** Opens a ChaCha20-Poly1305 ciphertext; any failure is a 4400 (CONTRACT Record layer). */
export function aeadOpen(
  key: Uint8Array,
  n: number,
  ad: Uint8Array,
  ciphertext: Uint8Array,
): Uint8Array {
  if (ciphertext.length < TAG_LENGTH) {
    throw new PenError("decrypt-failed", "record shorter than its tag", { closeCode: 4400 });
  }
  try {
    return chacha20poly1305(key, noiseNonce(n), ad).decrypt(ciphertext);
  } catch (cause) {
    throw new PenError("decrypt-failed", "record failed to decrypt", { closeCode: 4400, cause });
  }
}
