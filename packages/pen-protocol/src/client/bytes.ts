// Byte helpers that need neither Buffer nor TextEncoder, which Hermes may lack.

export function concatBytes(...parts: ReadonlyArray<Uint8Array>): Uint8Array {
  let length = 0;
  for (const part of parts) length += part.length;
  const out = new Uint8Array(length);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** Equal length and content, without an early exit on the first difference. */
export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
}

const HEX = "0123456789abcdef";

export function toHex(bytes: Uint8Array): string {
  let out = "";
  for (const byte of bytes) out += (HEX[byte >> 4] ?? "") + (HEX[byte & 15] ?? "");
  return out;
}

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new TypeError("invalid hex");
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const B64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

/** base64url without padding (RFC 4648 section 5). */
export function toBase64Url(bytes: Uint8Array): string {
  let out = "";
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    const left = bytes.length - i;
    out += B64URL[b0 >> 2] ?? "";
    out += B64URL[((b0 & 3) << 4) | (b1 >> 4)] ?? "";
    if (left > 1) out += B64URL[((b1 & 15) << 2) | (b2 >> 6)] ?? "";
    if (left > 2) out += B64URL[b2 & 63] ?? "";
  }
  return out;
}

/** Canonical unpadded base64url, or null: the text must re-encode to itself. */
export function fromBase64Url(text: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text) || text.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((text.length * 3) / 4));
  let bits = 0;
  let value = 0;
  let at = 0;
  for (const char of text) {
    value = (value << 6) | B64URL.indexOf(char);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (value >> bits) & 255;
      value &= (1 << bits) - 1;
    }
  }
  return toBase64Url(out) === text ? out : null;
}

/** UTF-8 of a well-formed string; lone surrogates are refused. */
export function utf8Encode(text: string): Uint8Array {
  const out: Array<number> = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const low = text.charCodeAt(i + 1);
      if (!(low >= 0xdc00 && low <= 0xdfff)) throw new TypeError("lone surrogate");
      code = 0x10000 + ((code - 0xd800) << 10) + (low - 0xdc00);
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      throw new TypeError("lone surrogate");
    }
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 63));
    else if (code < 0x10000)
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 63), 0x80 | (code & 63));
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 63),
        0x80 | ((code >> 6) & 63),
        0x80 | (code & 63),
      );
  }
  return Uint8Array.from(out);
}

/** ASCII only; anything else is a caller bug. */
export function asciiEncode(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 127) throw new TypeError("not ASCII");
    out[i] = code;
  }
  return out;
}

/** n (a safe integer, at most 2^53 - 1) as 8 little-endian bytes. */
export function u64le(n: number): Uint8Array {
  const out = new Uint8Array(8);
  let low = n % 0x1_0000_0000;
  let high = Math.floor(n / 0x1_0000_0000);
  for (let i = 0; i < 4; i++) {
    out[i] = low & 255;
    low = Math.floor(low / 256);
    out[4 + i] = high & 255;
    high = Math.floor(high / 256);
  }
  return out;
}
