// @effect-diagnostics-next-line nodeBuiltinImport:off -- HMAC is provided by node:crypto.
import * as NodeCrypto from "node:crypto";

export type AuthenticatorSetup = {
  readonly secret: string;
  readonly algorithm: "SHA1" | "SHA256" | "SHA512";
  readonly digits: 6 | 8;
  readonly period: number;
};

const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function decodeBase32(value: string): Uint8Array | undefined {
  const normalized = value.replace(/ /g, "").toUpperCase();
  if (!/^[A-Z2-7]+={0,6}$/.test(normalized)) return undefined;
  const raw = normalized.replace(/=+$/, "");
  const remainder = raw.length % 8;
  if (![0, 2, 4, 5, 7].includes(remainder)) return undefined;
  if (normalized.includes("=") && normalized.length % 8 !== 0) return undefined;
  let bits = 0;
  let accumulator = 0;
  const bytes: number[] = [];
  for (const character of raw) {
    accumulator = (accumulator << 5) | alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((accumulator >>> bits) & 255);
      accumulator &= (1 << bits) - 1;
    }
  }
  return accumulator === 0 && bytes.length > 0 ? Uint8Array.from(bytes) : undefined;
}

export function parseSetupKey(value: string): AuthenticatorSetup | undefined {
  const input = value.trim();
  let secret = input;
  let algorithm: AuthenticatorSetup["algorithm"] = "SHA1";
  let digits: AuthenticatorSetup["digits"] = 6;
  let period = 30;
  if (/^otpauth:/i.test(input)) {
    let uri: URL;
    try {
      uri = new URL(input);
    } catch {
      return undefined;
    }
    if (
      uri.protocol !== "otpauth:" ||
      uri.hostname !== "totp" ||
      uri.pathname.length < 2 ||
      uri.hash ||
      uri.username ||
      uri.password ||
      uri.port
    )
      return undefined;
    for (const key of ["secret", "algorithm", "digits", "period"]) {
      if (uri.searchParams.getAll(key).length > 1) return undefined;
    }
    secret = uri.searchParams.get("secret") ?? "";
    const requestedAlgorithm = (uri.searchParams.get("algorithm") ?? "SHA1").toUpperCase();
    if (
      requestedAlgorithm !== "SHA1" &&
      requestedAlgorithm !== "SHA256" &&
      requestedAlgorithm !== "SHA512"
    )
      return undefined;
    algorithm = requestedAlgorithm;
    const requestedDigits = uri.searchParams.get("digits") ?? "6";
    if (requestedDigits !== "6" && requestedDigits !== "8") return undefined;
    digits = requestedDigits === "6" ? 6 : 8;
    const requestedPeriod = uri.searchParams.get("period") ?? "30";
    if (!/^\d+$/.test(requestedPeriod)) return undefined;
    period = Number(requestedPeriod);
    if (period < 15 || period > 120) return undefined;
  }
  if (decodeBase32(secret) === undefined) return undefined;
  return {
    secret: secret.replace(/ /g, "").replace(/=+$/, "").toUpperCase(),
    algorithm,
    digits,
    period,
  };
}

export function generateCode(setup: AuthenticatorSetup, nowMillis: number): string {
  const key = decodeBase32(setup.secret);
  if (key === undefined) throw new Error("Invalid authenticator setup key");
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(nowMillis / 1000 / setup.period)));
  const digest = NodeCrypto.createHmac(setup.algorithm.toLowerCase(), key).update(counter).digest();
  const offset = digest.readUInt8(digest.length - 1) & 15;
  const number = (digest.readUInt32BE(offset) & 0x7fffffff) % 10 ** setup.digits;
  return number.toString().padStart(setup.digits, "0");
}
