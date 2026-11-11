const BASE32_DIGITS = "abcdefghijklmnopqrstuvwxyz234567";

/** RFC 4648 section 6 base32 in lowercase, without the "=" padding. */
export function base32(bytes: Uint8Array): string {
  const digits = Array.from({ length: Math.ceil((bytes.length * 8) / 5) }, (_, digit) => {
    const firstBit = digit * 5;
    const at = firstBit >> 3;
    // A digit spans at most two bytes; bytes past the end count as zero.
    const pair = ((bytes[at] ?? 0) << 8) | (bytes[at + 1] ?? 0);
    return BASE32_DIGITS.charAt((pair >> (11 - (firstBit & 7))) & 31);
  });
  return digits.join("");
}

export async function sha256(bytes: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>));
}

/** 26 characters: base32 of the first 16 bytes of SHA-256(signPub). */
export async function nodeIdFromSignPub(signPub: Uint8Array): Promise<string> {
  return base32((await sha256(signPub)).subarray(0, 16));
}

/** First 20 bytes of SHA-256(noisePub), uppercase hex, 10 groups of 4 separated by spaces. */
export async function fingerprint(noisePub: Uint8Array): Promise<string> {
  const hex = toHex((await sha256(noisePub)).subarray(0, 20)).toUpperCase();
  return hex.match(/.{4}/g)?.join(" ") ?? "";
}

export function isNodeId(value: string): boolean {
  return /^[a-z2-7]{26}$/.test(value);
}

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array<ArrayBuffer> {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) throw new Error("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const ED25519_PKCS8 = fromHex("302e020100300506032b657004220420");
const X25519_PKCS8 = fromHex("302e020100300506032b656e04220420");

function pkcs8(prefix: Uint8Array, seed: Uint8Array): Uint8Array<ArrayBuffer> {
  if (seed.length !== 32) throw new Error("seed must be 32 bytes");
  const out = new Uint8Array(prefix.length + 32);
  out.set(prefix);
  out.set(seed, prefix.length);
  return out;
}

function base64urlDecode(text: string): Uint8Array {
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export interface SigningKey {
  readonly signPub: Uint8Array;
  sign(message: Uint8Array): Promise<Uint8Array>;
}

/** An Ed25519 key from its 32-byte seed (RFC 8032 private key). */
export async function signingKeyFromSeed(seed: Uint8Array): Promise<SigningKey> {
  const key = await crypto.subtle.importKey("pkcs8", pkcs8(ED25519_PKCS8, seed), "Ed25519", true, [
    "sign",
  ]);
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return {
    signPub: base64urlDecode(jwk.x ?? ""),
    sign: async (message) =>
      new Uint8Array(await crypto.subtle.sign("Ed25519", key, message as Uint8Array<ArrayBuffer>)),
  };
}

/** The X25519 public key of a 32-byte private key (clamped as RFC 7748 defines). */
export async function x25519PublicKey(privateKey: Uint8Array): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "pkcs8",
    pkcs8(X25519_PKCS8, privateKey),
    "X25519",
    true,
    ["deriveBits"],
  );
  const jwk = await crypto.subtle.exportKey("jwk", key);
  return base64urlDecode(jwk.x ?? "");
}
