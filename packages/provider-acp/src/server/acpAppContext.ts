// @effect-diagnostics-next-line nodeBuiltinImport:off -- Delivery preparation hashes synchronously.
import * as NodeCrypto from "node:crypto";

const MAX_SESSIONS = 64;
const MAX_ENTRIES = 64;
const MAX_BYTES = 256 * 1024;

type Entry = { readonly key: string; readonly text: string };
type Session = {
  readonly entries: Map<string, string>;
  nextSequence: number;
  committedSequence: number;
};

const bytes = (text: string) => Buffer.byteLength(text, "utf8");
const fingerprint = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (character) => {
    switch (character) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&apos;";
    }
  });
}

export function createAcpAppContext() {
  const sessions = new Map<string, Session>();

  function trim() {
    let entryCount = 0;
    let byteCount = 0;
    for (const [id, session] of sessions) {
      byteCount += bytes(id);
      entryCount += session.entries.size;
      for (const [key, value] of session.entries) byteCount += bytes(key) + bytes(value);
    }
    while (sessions.size > MAX_SESSIONS || entryCount > MAX_ENTRIES || byteCount > MAX_BYTES) {
      const oldest = sessions.entries().next().value;
      if (oldest === undefined) break;
      const [id, session] = oldest;
      sessions.delete(id);
      byteCount -= bytes(id);
      entryCount -= session.entries.size;
      for (const [key, value] of session.entries) byteCount -= bytes(key) + bytes(value);
    }
  }

  function prepare(input: {
    readonly sessionId: string;
    readonly userText: string;
    readonly appContext?: ReadonlyArray<Entry>;
  }) {
    const entries = (input.appContext ?? []).filter((entry) => entry.key !== "goat_memory");
    if (input.userText.trimStart().startsWith("/") || entries.length === 0) {
      return { blocks: [], commit: () => false };
    }
    if (entries.length > MAX_ENTRIES || bytes(input.sessionId) > MAX_BYTES) {
      throw new RangeError("ACP app context exceeds its size limit");
    }
    const keys = new Set<string>();
    let inputBytes = bytes(input.sessionId);
    for (const { key, text } of entries) {
      if (!/^[A-Za-z_][A-Za-z0-9_.-]*$/.test(key)) {
        throw new Error("Invalid or reserved ACP app context key");
      }
      if (keys.has(key)) throw new Error("Duplicate ACP app context key");
      keys.add(key);
      if (/[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/u.test(text)) {
        throw new Error("Invalid XML character in ACP app context");
      }
      inputBytes += bytes(key) + bytes(text);
      if (inputBytes > MAX_BYTES) throw new RangeError("ACP app context exceeds its size limit");
    }
    const prepared = entries.map(({ key, text }) => ({
      key,
      hash: fingerprint(text),
      block: {
        type: "text" as const,
        text: `<external_${key}>${escapeXml(text)}</external_${key}>`,
      },
    }));
    if (
      prepared.reduce((total, entry) => total + bytes(entry.block.text), bytes(input.sessionId)) >
      MAX_BYTES
    ) {
      throw new RangeError("ACP app context exceeds its size limit");
    }
    let session = sessions.get(input.sessionId);
    if (session === undefined) {
      session = { entries: new Map(), nextSequence: 0, committedSequence: 0 };
      sessions.set(input.sessionId, session);
    } else {
      sessions.delete(input.sessionId);
      sessions.set(input.sessionId, session);
    }
    trim();
    const state = session;
    const unsent = prepared.filter(({ key, hash }) => state.entries.get(key) !== hash);
    const blocks = unsent.map(({ block }) => block);
    const sequence = ++state.nextSequence;
    return {
      blocks,
      commit: () => {
        if (sessions.get(input.sessionId) !== state || sequence <= state.committedSequence)
          return false;
        state.committedSequence = sequence;
        for (const { key, hash } of unsent) {
          state.entries.delete(key);
          state.entries.set(key, hash);
        }
        trim();
        return true;
      },
    };
  }

  return {
    prepare,
    invalidate: (sessionId: string) => {
      sessions.delete(sessionId);
    },
    clear: () => {
      sessions.clear();
    },
  };
}
