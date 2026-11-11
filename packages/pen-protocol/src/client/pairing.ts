// The pairing QR (design 9.1), its relay rules (9.3) and the pairing derivations (5.1), for the phone.
import { asciiEncode, concatBytes, fromBase64Url, toBase64Url } from "./bytes.ts";
import { hkdfSha256, sha256 } from "./crypto.ts";
import { PenError } from "./errors.ts";

/** The schemes a GOAT app build registers (packages/shared/src/mobileAppIdentity.ts APP_SCHEMES). */
export const PAIR_LINK_SCHEMES = ["goat", "goat-dev", "goat-preview"] as const;
export const PAIR_QR_VERSION = 1;
export const PAIR_QR_MIN = 88;
export const PAIR_QR_MAX = 216;
/** An expiry this far past is still accepted: it is display and early refusal only; the daemon enforces the real one. */
export const PAIR_QR_SKEW_SECONDS = 60;
export const GOAT_SERVICE = "goat";

const HEAD = 86;

export interface PairQrFields {
  readonly nodeId: string;
  readonly serverNoisePub: Uint8Array;
  readonly secret: Uint8Array;
  /** Unix seconds. */
  readonly expiresAt: number;
  readonly relays: ReadonlyArray<string>;
}

export interface PairQr extends PairQrFields {
  /** Normalized wss origins, each on the compiled list. */
  readonly relays: ReadonlyArray<string>;
}

const qrError = (rule: string, message: string) => new PenError("qr/" + rule, message);

const BASE32 = "abcdefghijklmnopqrstuvwxyz234567";

function base32Encode(bytes: Uint8Array): string {
  let out = "";
  let bits = 0;
  let value = 0;
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      out += BASE32[(value >> bits) & 31] ?? "";
    }
    value &= (1 << bits) - 1;
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31] ?? "";
  return out;
}

function base32Decode(text: string): Uint8Array | null {
  if (!/^[a-z2-7]*$/.test(text)) return null;
  const out = new Uint8Array(Math.floor((text.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const char of text) {
    value = (value << 5) | BASE32.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 255;
      value &= (1 << bits) - 1;
    }
  }
  return base32Encode(out) === text ? out : null;
}

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;

/** `wss://<host>` for an https or wss URL on port 443 with no userinfo, path, query or fragment; otherwise null. */
export function normalizeRelayOrigin(url: string): string | null {
  const match = /^(https|wss):\/\/([^/?#@:]+)(?::([0-9]{1,5}))?\/?$/i.exec(url);
  if (match === null) return null;
  const host = (match[2] ?? "").toLowerCase();
  if (match[3] !== undefined && match[3] !== "443") return null;
  return HOST.test(host) ? "wss://" + host : null;
}

function compiledOrigins(compiled: ReadonlyArray<string>): Set<string> {
  const out = new Set<string>();
  for (const url of compiled) {
    const origin = normalizeRelayOrigin(url);
    if (origin !== null) out.add(origin);
  }
  return out;
}

/** A later relay list, kept to the compiled list; an empty result keeps the current list (design 9.3). */
export function filterRelays(
  compiled: ReadonlyArray<string>,
  offered: ReadonlyArray<string>,
  current: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const allowed = compiledOrigins(compiled);
  const kept: Array<string> = [];
  for (const url of offered) {
    const origin = normalizeRelayOrigin(url);
    if (origin !== null && allowed.has(origin) && !kept.includes(origin)) kept.push(origin);
  }
  return kept.length > 0 ? kept : current;
}

export function encodePairQr(fields: PairQrFields): Uint8Array {
  const nodeId = base32Decode(fields.nodeId);
  if (nodeId === null || nodeId.length !== 16)
    throw qrError("node-id", "node id is not 26 base32 characters");
  const relays = fields.relays.map((relay) => asciiEncode(relay));
  const head = new Uint8Array(HEAD);
  head[0] = PAIR_QR_VERSION;
  head.set(nodeId, 1);
  head.set(fields.serverNoisePub, 17);
  head.set(fields.secret, 49);
  new DataView(head.buffer).setUint32(81, fields.expiresAt);
  head[85] = relays.length;
  return concatBytes(head, ...relays.flatMap((relay) => [Uint8Array.of(relay.length), relay]));
}

function payloadOf(input: string | Uint8Array): Uint8Array {
  if (input instanceof Uint8Array) return input;
  const match = /^([a-z-]+):\/\/pair\?pen=([A-Za-z0-9_-]+)$/.exec(input);
  const scheme = match?.[1];
  const bytes = match?.[2] === undefined ? null : fromBase64Url(match[2]);
  if (
    scheme === undefined ||
    !(PAIR_LINK_SCHEMES as ReadonlyArray<string>).includes(scheme) ||
    bytes === null
  ) {
    throw qrError("link", "not a GOAT Pen pairing link");
  }
  return bytes;
}

/** Decodes a scanned Pen pairing QR, refusing the whole QR on any rule of design 9.1 and 9.3. */
export function decodePairQr(
  input: string | Uint8Array,
  options: { readonly compiledRelays: ReadonlyArray<string>; readonly nowSeconds: number },
): PairQr {
  const bytes = payloadOf(input);
  if (bytes.length < PAIR_QR_MIN || bytes.length > PAIR_QR_MAX) {
    throw qrError("length", "a pairing QR is 88 to 216 bytes");
  }
  if (bytes[0] !== PAIR_QR_VERSION) throw qrError("version", "unknown pairing QR version");
  const nodeId = base32Encode(bytes.subarray(1, 17));
  const serverNoisePub = bytes.slice(17, 49);
  if (serverNoisePub.every((byte) => byte === 0)) throw qrError("server-key", "server key is zero");
  const secret = bytes.slice(49, 81);
  const expiresAt = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(81);
  const count = bytes[85] ?? 0;
  if (count < 1 || count > 2) throw qrError("relay-count", "a pairing QR names one or two relays");
  const allowed = compiledOrigins(options.compiledRelays);
  const relays: Array<string> = [];
  let at = HEAD;
  for (let i = 0; i < count; i++) {
    const length = bytes[at] ?? 0;
    if (length < 1 || length > 64) throw qrError("relay-length", "a relay URL is 1 to 64 bytes");
    if (at + 1 + length > bytes.length) throw qrError("length", "the QR ends inside a relay URL");
    const raw = bytes.subarray(at + 1, at + 1 + length);
    at += 1 + length;
    const text = raw.every((byte) => byte >= 0x21 && byte <= 0x7e)
      ? String.fromCharCode(...raw)
      : "";
    const origin = normalizeRelayOrigin(text);
    if (origin === null)
      throw qrError("relay-url", "a relay URL must be https or wss on port 443 with no path");
    if (relays.includes(origin)) throw qrError("relay-duplicate", "a relay is named twice");
    if (!allowed.has(origin))
      throw qrError("relay-not-allowed", "a relay is not one this app dials");
    relays.push(origin);
  }
  if (at !== bytes.length) throw qrError("trailing", "bytes follow the last relay");
  if (options.nowSeconds > expiresAt + PAIR_QR_SKEW_SECONDS)
    throw qrError("expired", "the pairing QR expired");
  return { nodeId, serverNoisePub, secret, expiresAt, relays };
}

/** I = base64url(SHA-256("pen/1 service invite" || S)[0..12]). */
export function serviceInviteId(secret: Uint8Array): string {
  return toBase64Url(sha256(asciiEncode("pen/1 service invite"), secret).subarray(0, 12));
}

/** psk = HKDF-SHA256(S, salt empty, info "pen/1 service psk" || nodeId || serverNoisePub || N, 32). */
export function servicePsk(
  secret: Uint8Array,
  nodeId: string,
  serverNoisePub: Uint8Array,
  name: string,
): Uint8Array {
  const info = concatBytes(
    asciiEncode("pen/1 service psk" + nodeId),
    serverNoisePub,
    asciiEncode(name),
  );
  return hkdfSha256(secret, new Uint8Array(0), info, 32);
}

/** sas = SHA-256("goat-pair/1 sas" || h). */
export function pairingSas(handshakeHash: Uint8Array): Uint8Array {
  return sha256(asciiEncode("goat-pair/1 sas"), handshakeHash);
}

/** Six digits: big-endian u64 of sas[0..8] mod 10^6, computed with safe integers. */
export function pairingCode(sas: Uint8Array): string {
  if (sas.length < 8) throw new PenError("sas-invalid", "sas is shorter than 8 bytes");
  const view = new DataView(sas.buffer, sas.byteOffset, 8);
  const high = view.getUint32(0);
  const low = view.getUint32(4);
  const value = ((high % 1_000_000) * (2 ** 32 % 1_000_000) + low) % 1_000_000;
  return value.toString().padStart(6, "0");
}

/** Message 1 payload for a pairing handshake (kind 0x03), in Go's Payload member order. */
export function servicePairPayload(name: string, inviteId: string) {
  return { v: 1, stream: "service-pair", invite: inviteId, name };
}

/** Message 1 payload for a client session (kind 0x01). */
export function servicePayload(name: string) {
  return { v: 1, stream: "service", name };
}
