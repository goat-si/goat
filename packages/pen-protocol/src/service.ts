// @effect-diagnostics nodeBuiltinImport:off - HMAC-SHA256 for the Pen local delivery (CONTRACT "Services").
import * as NodeCrypto from "node:crypto";

// The program side of a Pen local delivery: line 1 in, line 2 out, line 3 in (CONTRACT "Local delivery").

export const PEN_SERVICE_LINE1_CAP = 128;
export const PEN_SERVICE_LINE3_CAP = 2200;

export interface PenServiceCaller {
  readonly nodeId: string;
  readonly signPub: string;
  readonly noisePub: string;
  readonly name: string;
}

export interface PenServiceIdentity {
  readonly mesh: string;
  readonly self: string;
  readonly caller: PenServiceCaller;
  readonly stream: string;
}

const KEY_TEXT = /^[A-Za-z0-9_-]{43}$/;
const ID = /^[a-z2-7]{26}$/;
const NODE_NAME = /^[a-z0-9][a-z0-9_.-]{0,31}$/;
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,31}$/;

/** 43 canonical base64url characters that decode to 32 bytes, or null. */
export function decodeKey32(text: string): Uint8Array | null {
  if (!KEY_TEXT.test(text)) return null;
  const bytes = Buffer.from(text, "base64url");
  if (bytes.byteLength !== 32 || bytes.toString("base64url") !== text) return null;
  return new Uint8Array(bytes);
}

export function encodeKey32(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

export function validServiceName(name: string): boolean {
  return SERVICE_NAME.test(name) && name !== "pen";
}

function mac(key: Uint8Array, label: string, ...parts: Uint8Array[]): Buffer {
  const h = NodeCrypto.createHmac("sha256", key);
  h.update(label, "ascii");
  for (const part of parts) h.update(part);
  return h.digest();
}

function ascii(line: Uint8Array, cap: number): string {
  if (line.byteLength > cap) throw new Error("line over its cap");
  if (line.byteLength === 0 || line[line.byteLength - 1] !== 10)
    throw new Error("line does not end in LF");
  for (let i = 0; i < line.byteLength - 1; i++) {
    const c = line[i] ?? 0;
    if (c === 10 || c === 13 || c > 126 || c < 32)
      throw new Error("line holds a byte outside printable ASCII");
  }
  return Buffer.from(line.subarray(0, line.byteLength - 1)).toString("latin1");
}

/** Line 1, PENSVC/1 Nd LF: returns Nd. */
export function parseServiceHello(line: Uint8Array): Uint8Array {
  const text = ascii(line, PEN_SERVICE_LINE1_CAP);
  const nd = text.startsWith("PENSVC/1 ") ? decodeKey32(text.slice(9)) : null;
  if (nd === null) throw new Error("line 1 is not PENSVC/1 <Nd>");
  return nd;
}

/** Line 2, Ng SP A LF, for a fresh Ng. */
export function serviceAnswer(
  key: Uint8Array,
  name: string,
  nd: Uint8Array,
  ng: Uint8Array,
): Uint8Array {
  const a = mac(key, "pen-svc/1 " + name, nd, ng);
  return Buffer.from(encodeKey32(ng) + " " + encodeKey32(a) + "\n", "latin1");
}

export interface PenServicePin {
  readonly key: Uint8Array;
  readonly name: string;
  readonly nd: Uint8Array;
  readonly ng: Uint8Array;
  /** The mesh id and node id this program pinned for its machine. */
  readonly mesh: string;
  readonly self: string;
}

function canonical(identity: PenServiceIdentity): string {
  const c = identity.caller;
  return JSON.stringify({
    v: 1,
    mesh: identity.mesh,
    self: identity.self,
    caller: { nodeId: c.nodeId, signPub: c.signPub, noisePub: c.noisePub, name: c.name },
    stream: identity.stream,
  });
}

function str(value: unknown): string {
  if (typeof value !== "string") throw new Error("identity member is not a string");
  return value;
}

/**
 * Line 3, J SP B LF: verifies B over J's exact bytes, then that J is exactly the canonical rendering of
 * valid values (so no unknown, missing, duplicate or reordered member and no whitespace), and that it
 * names the pinned mesh and node and this service.
 */
export function verifyServiceIdentity(line: Uint8Array, pin: PenServicePin): PenServiceIdentity {
  const text = ascii(line, PEN_SERVICE_LINE3_CAP);
  const sp = text.lastIndexOf(" ");
  const b = sp > 0 ? decodeKey32(text.slice(sp + 1)) : null;
  if (b === null) throw new Error("line 3 is not <J> <B>");
  const j = text.slice(0, sp);
  const want = mac(pin.key, "pen-svc/1 pen", pin.nd, pin.ng, Buffer.from(j, "latin1"));
  if (!NodeCrypto.timingSafeEqual(want, b))
    throw new Error("line 3 does not prove the registered key");
  const parsed: unknown = JSON.parse(j);
  if (typeof parsed !== "object" || parsed === null) throw new Error("J is not an object");
  const o = parsed as Record<string, unknown>;
  const caller = o["caller"];
  if (typeof caller !== "object" || caller === null) throw new Error("J has no caller");
  const cr = caller as Record<string, unknown>;
  const identity: PenServiceIdentity = {
    mesh: str(o["mesh"]),
    self: str(o["self"]),
    caller: {
      nodeId: str(cr["nodeId"]),
      signPub: str(cr["signPub"]),
      noisePub: str(cr["noisePub"]),
      name: str(cr["name"]),
    },
    stream: str(o["stream"]),
  };
  const ok =
    ID.test(identity.mesh) &&
    ID.test(identity.self) &&
    ID.test(identity.caller.nodeId) &&
    decodeKey32(identity.caller.signPub) !== null &&
    decodeKey32(identity.caller.noisePub) !== null &&
    NODE_NAME.test(identity.caller.name) &&
    validServiceName(identity.stream);
  if (!ok || canonical(identity) !== j) throw new Error("J is not the exact identity line");
  if (identity.mesh !== pin.mesh || identity.self !== pin.self)
    throw new Error("J names another mesh or node");
  if (identity.stream !== pin.name) throw new Error("J names another service");
  return identity;
}
