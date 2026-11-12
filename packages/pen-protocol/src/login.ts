import { base32, type SigningKey, sha256 } from "./identity.ts";

const encoder = new TextEncoder();

export const LoginPrefix = {
  start: "pen-login/1 start",
  poll: "pen-login/1 poll",
  forget: "pen-login/1 forget",
  register: "pen-login/1 register",
  assertion: "pen-login/1 assertion",
} as const;

/** Assertions live 10 minutes (exp = iat + 600). */
export const ASSERTION_TTL_S = 600;

const B64URL = /^[A-Za-z0-9_-]*$/;

/** base64url without padding. */
export function base64url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Strict base64url without padding; throws on anything else. */
export function fromBase64url(text: string): Uint8Array<ArrayBuffer> {
  if (!B64URL.test(text) || text.length % 4 === 1) throw new Error("invalid base64url");
  const binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  if (base64url(out) !== text) throw new Error("non-canonical base64url");
  return out;
}

function concat(parts: ReadonlyArray<Uint8Array>): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** `"pen-login/1 start" || signPub || noisePub || name` (UTF-8). */
export function startProofMessage(
  signPub: Uint8Array,
  noisePub: Uint8Array,
  name: string,
): Uint8Array<ArrayBuffer> {
  return concat([encoder.encode(LoginPrefix.start), signPub, noisePub, encoder.encode(name)]);
}

/** `"pen-login/1 poll" || deviceCode`, the device code's 32 raw bytes. */
export function pollProofMessage(deviceCode: Uint8Array): Uint8Array<ArrayBuffer> {
  return concat([encoder.encode(LoginPrefix.poll), deviceCode]);
}

/** `"pen-login/1 forget" || nodeId || ts`, nodeId as 26 ASCII characters and ts as u64 big-endian milliseconds. */
export function forgetProofMessage(nodeId: string, ts: number): Uint8Array<ArrayBuffer> {
  const time = new Uint8Array(8);
  new DataView(time.buffer).setBigUint64(0, BigInt(ts), false);
  return concat([encoder.encode(LoginPrefix.forget), encoder.encode(nodeId), time]);
}

/** `"pen-login/1 register" || SHA-256(assertion body bytes) || meshId` (26 ASCII characters). */
export async function registerProofMessage(
  assertionBody: Uint8Array,
  meshId: string,
): Promise<Uint8Array<ArrayBuffer>> {
  return concat([
    encoder.encode(LoginPrefix.register),
    await sha256(assertionBody),
    encoder.encode(meshId),
  ]);
}

/** Lowercase base32 of SHA-256(pub)[0..5]: 8 characters. */
export async function loginKid(pub: Uint8Array): Promise<string> {
  return base32((await sha256(pub)).subarray(0, 5));
}

export interface LoginKey {
  readonly kid: string;
  /** base64url Ed25519 public key. */
  readonly pub: string;
}

export interface AssertionBody {
  readonly v: 1;
  readonly iss: string;
  readonly kid: string;
  readonly sub: string;
  readonly email: string;
  readonly signPub: string;
  readonly noisePub: string;
  readonly iat: number;
  readonly exp: number;
}

export interface Assertion {
  readonly body: string;
  readonly sig: string;
}

/** The body as I-JSON in the contract's member order. */
export function encodeAssertionBody(body: AssertionBody): Uint8Array<ArrayBuffer> {
  const ordered = {
    v: body.v,
    iss: body.iss,
    kid: body.kid,
    sub: body.sub,
    email: body.email,
    signPub: body.signPub,
    noisePub: body.noisePub,
    iat: body.iat,
    exp: body.exp,
  };
  return encoder.encode(JSON.stringify(ordered));
}

/** `"pen-login/1 assertion" || SHA-256(body)` */
export async function assertionSigningMessage(body: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
  return concat([encoder.encode(LoginPrefix.assertion), await sha256(body)]);
}

export async function signAssertion(body: AssertionBody, key: SigningKey): Promise<Assertion> {
  const bytes = encodeAssertionBody(body);
  return {
    body: base64url(bytes),
    sig: base64url(await key.sign(await assertionSigningMessage(bytes))),
  };
}

/** base64url SHA-256 of the body bytes; registers and admits name an assertion by it. */
export async function assertionHash(assertion: Assertion): Promise<string> {
  return base64url(await sha256(fromBase64url(assertion.body)));
}

export type AssertionFailure =
  | "malformed"
  | "unknown_kid"
  | "bad_signature"
  | "wrong_iss"
  | "wrong_sub"
  | "not_yet_valid"
  | "expired"
  | "key_mismatch";

export interface AssertionCheck {
  readonly keys: ReadonlyArray<LoginKey>;
  readonly iss: string;
  /** Unix seconds. */
  readonly now: number;
  /** Seconds of clock skew allowed on iat and exp: 0 for the login service, 60 for members. */
  readonly skew: number;
  readonly sub?: string;
  readonly signPub?: string;
  readonly noisePub?: string;
}

export type AssertionResult =
  | { readonly ok: true; readonly body: AssertionBody }
  | { readonly ok: false; readonly reason: AssertionFailure };

const isKey = (value: unknown): value is string => {
  if (typeof value !== "string") return false;
  try {
    return fromBase64url(value).length === 32;
  } catch {
    return false;
  }
};

/** No C0 control characters or DEL: members print sub and email in their terminals. */
const CONTROL = /[\u0000-\u001f\u007f]/;
function printable(value: unknown): boolean {
  return typeof value === "string" && !CONTROL.test(value);
}

function parseBody(bytes: Uint8Array): AssertionBody | null {
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  const strings = ["iss", "kid", "sub", "email"].every(
    (field) => typeof body[field] === "string" && body[field] !== "" && printable(body[field]),
  );
  const times =
    Number.isSafeInteger(body.iat) &&
    Number.isSafeInteger(body.exp) &&
    (body.exp as number) > (body.iat as number) &&
    (body.exp as number) - (body.iat as number) <= ASSERTION_TTL_S;
  if (body.v !== 1 || !strings || !times || !isKey(body.signPub) || !isKey(body.noisePub))
    return null;
  return body as unknown as AssertionBody;
}

/** Verifies the signature, then the claims, in the order the failure reasons are listed. */
export async function checkAssertion(
  assertion: Assertion,
  check: AssertionCheck,
): Promise<AssertionResult> {
  let bytes: Uint8Array<ArrayBuffer>;
  let sig: Uint8Array<ArrayBuffer>;
  try {
    bytes = fromBase64url(assertion.body);
    sig = fromBase64url(assertion.sig);
  } catch {
    return { ok: false, reason: "malformed" };
  }
  const body = parseBody(bytes);
  if (body === null || sig.length !== 64) return { ok: false, reason: "malformed" };
  const key = check.keys.find((candidate) => candidate.kid === body.kid);
  if (!key) return { ok: false, reason: "unknown_kid" };
  const publicKey = await crypto.subtle.importKey("raw", fromBase64url(key.pub), "Ed25519", false, [
    "verify",
  ]);
  const message = await assertionSigningMessage(bytes);
  if (!(await crypto.subtle.verify("Ed25519", publicKey, sig, message)))
    return { ok: false, reason: "bad_signature" };
  if (body.iss !== check.iss) return { ok: false, reason: "wrong_iss" };
  if (check.sub !== undefined && body.sub !== check.sub) return { ok: false, reason: "wrong_sub" };
  if (body.iat > check.now + check.skew) return { ok: false, reason: "not_yet_valid" };
  if (check.now >= body.exp + check.skew) return { ok: false, reason: "expired" };
  if (
    (check.signPub !== undefined && body.signPub !== check.signPub) ||
    (check.noisePub !== undefined && body.noisePub !== check.noisePub)
  ) {
    return { ok: false, reason: "key_mismatch" };
  }
  return { ok: true, body };
}
