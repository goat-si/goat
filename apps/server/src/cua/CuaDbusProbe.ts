// @effect-diagnostics nodeBuiltinImport:off -- Effect has no Unix-socket client; the D-Bus handshake needs one.
import * as NodeNet from "node:net";

import * as Effect from "effect/Effect";

// Just enough of the D-Bus wire protocol to prove a bus answers: SASL EXTERNAL, Hello, and one
// method call whose reply is a string. Messages are little-endian; replies may be either.

/** The socket of the first unix transport in a bus address; null for transports we cannot dial. */
export function dbusSocketPath(address: string): string | null {
  for (const entry of address.split(";")) {
    const match = /^unix:(.*)$/u.exec(entry.trim());
    if (!match?.[1]) continue;
    const keys = new Map(
      match[1].split(",").map((pair) => {
        const index = pair.indexOf("=");
        return [pair.slice(0, index), decodeURIComponent(pair.slice(index + 1))] as const;
      }),
    );
    const path = keys.get("path");
    if (path) return path;
    const abstract = keys.get("abstract");
    if (abstract) return `\0${abstract}`;
  }
  return null;
}

/** SASL EXTERNAL authenticates as this process's uid, written as hex of its decimal digits. */
export function dbusAuthLine(uid: number): string {
  const hex = [...String(uid)].map((digit) => digit.charCodeAt(0).toString(16)).join("");
  return `\0AUTH EXTERNAL ${hex}\r\n`;
}

export interface DbusMethodCall {
  readonly serial: number;
  readonly destination: string;
  readonly path: string;
  readonly interface: string;
  readonly member: string;
}

/** A METHOD_CALL with no body. */
export function dbusMethodCall(call: DbusMethodCall): Uint8Array {
  const bytes: number[] = [];
  const align = (n: number) => {
    while (bytes.length % n !== 0) bytes.push(0);
  };
  const u32 = (value: number) =>
    bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
  const string = (value: string) => {
    const encoded = new TextEncoder().encode(value);
    align(4);
    u32(encoded.length);
    bytes.push(...encoded, 0);
  };
  bytes.push(0x6c, 1, 0, 1);
  u32(0); // body length
  u32(call.serial);
  const lengthAt = bytes.length;
  u32(0); // header field array length, patched below
  const fields: Array<[number, "o" | "s", string]> = [
    [1, "o", call.path],
    [2, "s", call.interface],
    [3, "s", call.member],
    [6, "s", call.destination],
  ];
  const start = bytes.length;
  for (const [code, signature, value] of fields) {
    align(8);
    bytes.push(code, 1, signature.charCodeAt(0), 0);
    string(value);
  }
  const length = bytes.length - start;
  bytes[lengthAt] = length & 0xff;
  bytes[lengthAt + 1] = (length >>> 8) & 0xff;
  align(8);
  return Uint8Array.from(bytes);
}

export interface DbusMessage {
  readonly type: number;
  readonly replySerial: number | null;
  /** The first body value when the body starts with a string. */
  readonly text: string | null;
}

const align = (offset: number, n: number) => offset + ((n - (offset % n)) % n);

/** Whole messages at the start of `buffer`, and how many bytes they took. */
export function dbusParseMessages(buffer: Uint8Array): {
  readonly messages: ReadonlyArray<DbusMessage>;
  readonly consumed: number;
} {
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
  const decoder = new TextDecoder();
  const messages: DbusMessage[] = [];
  let at = 0;
  while (at + 16 <= buffer.byteLength) {
    const little = buffer[at] === 0x6c;
    if (!little && buffer[at] !== 0x42) throw new Error("not a D-Bus message");
    const type = buffer[at + 1] ?? 0;
    const bodyLength = view.getUint32(at + 4, little);
    const fieldsLength = view.getUint32(at + 12, little);
    // Alignment counts from each message's own start; a body leaves the next one unaligned.
    const headerEnd = at + align(16 + fieldsLength, 8);
    const end = headerEnd + bodyLength;
    if (end > buffer.byteLength) break;
    let replySerial: number | null = null;
    let signature = "";
    let offset = at + 16;
    while (offset < at + 16 + fieldsLength) {
      offset = align(offset - at, 8) + at;
      const code = buffer[offset] ?? 0;
      const sigLength = buffer[offset + 1] ?? 0;
      const valueType = String.fromCharCode(buffer[offset + 2] ?? 0);
      offset += 2 + sigLength + 1;
      if (valueType === "u") {
        offset = align(offset - at, 4) + at;
        if (code === 5) replySerial = view.getUint32(offset, little);
        offset += 4;
      } else if (valueType === "s" || valueType === "o") {
        offset = align(offset - at, 4) + at;
        offset += 4 + view.getUint32(offset, little) + 1;
      } else if (valueType === "g") {
        const length = buffer[offset] ?? 0;
        if (code === 8)
          signature = decoder.decode(buffer.subarray(offset + 1, offset + 1 + length));
        offset += 1 + length + 1;
      } else break;
    }
    const text =
      signature.startsWith("s") && bodyLength >= 4
        ? decoder.decode(
            buffer.subarray(headerEnd + 4, headerEnd + 4 + view.getUint32(headerEnd, little)),
          )
        : null;
    messages.push({ type, replySerial, text });
    at = end;
  }
  return { messages, consumed: at };
}

const METHOD_RETURN = 2;
const ERROR = 3;

const HELLO: Omit<DbusMethodCall, "serial"> = {
  destination: "org.freedesktop.DBus",
  path: "/org/freedesktop/DBus",
  interface: "org.freedesktop.DBus",
  member: "Hello",
};

export const A11Y_GET_ADDRESS: Omit<DbusMethodCall, "serial"> = {
  destination: "org.a11y.Bus",
  path: "/org/a11y/bus",
  interface: "org.a11y.Bus",
  member: "GetAddress",
};

export type DbusProbeResult =
  | { readonly answered: false }
  | {
      readonly answered: true;
      readonly reply: { readonly ok: boolean; readonly text: string | null };
    };

/**
 * Connects, authenticates, says Hello, and makes `call` (or only Hello). `answered` is false
 * when the bus is not there or does not complete the handshake within two seconds.
 */
export const dbusProbe = (
  address: string,
  uid: number,
  call: Omit<DbusMethodCall, "serial"> = HELLO,
) => {
  const socketPath = dbusSocketPath(address);
  if (socketPath === null) return Effect.succeed<DbusProbeResult>({ answered: false });
  const target = call === HELLO ? 1 : 2;
  return Effect.callback<DbusProbeResult>((resume) => {
    let settled = false;
    let authenticated = false;
    let pending = Buffer.alloc(0);
    const finish = (result: DbusProbeResult) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resume(Effect.succeed(result));
    };
    const socket = NodeNet.createConnection(socketPath);
    socket.once("connect", () => socket.write(dbusAuthLine(uid)));
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (!authenticated) {
        const end = pending.indexOf("\r\n");
        if (end < 0) return;
        const line = pending.subarray(0, end).toString("latin1");
        pending = pending.subarray(end + 2);
        if (!line.startsWith("OK ")) return finish({ answered: false });
        authenticated = true;
        socket.write("BEGIN\r\n");
        socket.write(dbusMethodCall({ serial: 1, ...HELLO }));
        if (target === 2) socket.write(dbusMethodCall({ serial: 2, ...call }));
      }
      try {
        const { messages, consumed } = dbusParseMessages(pending);
        pending = pending.subarray(consumed);
        for (const message of messages) {
          if (message.replySerial !== target) continue;
          if (message.type === METHOD_RETURN || message.type === ERROR)
            return finish({
              answered: true,
              reply: { ok: message.type === METHOD_RETURN, text: message.text },
            });
        }
      } catch {
        finish({ answered: false });
      }
    });
    socket.once("error", () => finish({ answered: false }));
    socket.once("close", () => finish({ answered: false }));
    return Effect.sync(() => socket.destroy());
  }).pipe(
    Effect.timeoutOrElse({
      duration: "2 seconds",
      orElse: () => Effect.succeed<DbusProbeResult>({ answered: false }),
    }),
  );
};
