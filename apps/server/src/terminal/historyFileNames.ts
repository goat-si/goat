// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect's Crypto digest is effectful; a sync hash keeps historyPath a plain function.
import * as NodeCrypto from "node:crypto";

import * as Base64Url from "effect/encoding/Base64Url";

export function legacySafeThreadId(threadId: string): string {
  return threadId.replace(/[^a-zA-Z0-9._-]/g, "_");
}

export function encodedHistoryThreadPart(threadId: string): string {
  return `terminal_${Base64Url.encode(threadId)}`;
}

export function hashId(id: string): string {
  return NodeCrypto.createHash("sha256").update(id).digest("base64url");
}

// "." is outside the base64url alphabet, so a hashed name can never collide with an encoded one.
export function hashedHistoryThreadPart(threadId: string): string {
  return `terminal_sha256.${hashId(threadId)}`;
}

export function joinHistoryFileName(threadPart: string, terminalPart: string | null): string {
  return terminalPart === null ? `${threadPart}.log` : `${threadPart}_${terminalPart}.log`;
}
