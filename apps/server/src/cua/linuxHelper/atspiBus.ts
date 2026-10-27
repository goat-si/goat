// @effect-diagnostics nodeBuiltinImport:off -- The Linux helper is its own Node process; D-Bus needs a raw socket.
// @effect-diagnostics globalTimers:off -- Call deadlines and the idle close at socket callback boundaries.
import * as NodeNet from "node:net";

import { busSocketPath } from "./atspiFocusEvents.ts";

/**
 * Method calls on the accessibility bus over one connection, opened at the first call and closed
 * once idle. A gdbus process per call forks the whole server, and a GTK4 window takes hundreds of
 * calls. Only the types the focus probe sends and reads are marshalled; a reply holding any other
 * type fails its call.
 */

export type DbusValue = string | number | boolean | ReadonlyArray<DbusValue>;

export interface BusCall {
  readonly destination: string;
  readonly path: string;
  readonly iface: string;
  readonly member: string;
  readonly signature?: string;
  readonly body?: ReadonlyArray<DbusValue>;
}

export interface BusReply {
  readonly signature: string;
  readonly body: ReadonlyArray<DbusValue>;
}

/** One method call and its reply, or a rejection: a BusError for an error reply. */
export type AtspiCall = (call: BusCall) => Promise<BusReply>;

/** An error reply. The name comes from the message header, never from text. */
export class BusError extends Error {
  readonly errorName: string;
  constructor(errorName: string, message: string) {
    super(errorName + ": " + message);
    this.errorName = errorName;
  }
}

const METHOD_CALL = 1;
const METHOD_RETURN = 2;
const ERROR = 3;
/** Far above any reply the probe reads; a /usr/bin window's children are about 100 KiB. */
const MAX_MESSAGE_BYTES = 8 << 20;
/** As gdbus was given: a call the app does not answer within this is a failed read. */
const CALL_TIMEOUT_MS = 1_000;
const SETUP_TIMEOUT_MS = 2_000;
const IDLE_CLOSE_MS = 10_000;

/** The end of the complete type starting at `at`. */
function typeEnd(signature: string, at: number): number {
  const code = signature[at];
  if (code === "a") return typeEnd(signature, at + 1);
  if (code === "(" || code === "{") {
    const close = code === "(" ? ")" : "}";
    let next = at + 1;
    while (signature[next] !== close) {
      if (next >= signature.length) throw new Error("A D-Bus signature ended early.");
      next = typeEnd(signature, next);
    }
    return next + 1;
  }
  if (code !== undefined && "ybiusogv".includes(code)) return at + 1;
  throw new Error("A D-Bus type this does not read.");
}

/** The complete types of a signature in order: "a(so)u" is ["a(so)", "u"]. */
export function completeTypes(signature: string): ReadonlyArray<string> {
  const types: string[] = [];
  for (let at = 0; at < signature.length;) {
    const end = typeEnd(signature, at);
    types.push(signature.slice(at, end));
    at = end;
  }
  return types;
}

const alignment = (type: string) =>
  type[0] === "(" || type[0] === "{"
    ? 8
    : type[0] === "y" || type[0] === "g" || type[0] === "v"
      ? 1
      : 4;

const listOf = (value: DbusValue): ReadonlyArray<DbusValue> => {
  if (!Array.isArray(value)) throw new Error("A D-Bus array or struct needs a list.");
  return value;
};

class Writer {
  readonly bytes: number[] = [];
  pad(n: number) {
    while (this.bytes.length % n !== 0) this.bytes.push(0);
  }
  u32(value: number) {
    this.pad(4);
    this.bytes.push(
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    );
  }
  setU32(at: number, value: number) {
    this.bytes.splice(
      at,
      4,
      value & 0xff,
      (value >>> 8) & 0xff,
      (value >>> 16) & 0xff,
      (value >>> 24) & 0xff,
    );
  }
  put(type: string, value: DbusValue) {
    const code = type[0];
    if (code === "y" && typeof value === "number") this.bytes.push(value & 0xff);
    else if (code === "b" && typeof value === "boolean") this.u32(value ? 1 : 0);
    else if ((code === "i" || code === "u") && typeof value === "number") this.u32(value);
    else if ((code === "s" || code === "o") && typeof value === "string") {
      const encoded = Buffer.from(value, "utf8");
      this.u32(encoded.length);
      this.bytes.push(...encoded, 0);
    } else if (code === "g" && typeof value === "string") {
      this.bytes.push(value.length, ...Buffer.from(value, "ascii"), 0);
    } else if (code === "a") {
      const element = type.slice(1);
      this.u32(0);
      const lengthAt = this.bytes.length - 4;
      this.pad(alignment(element));
      const start = this.bytes.length;
      for (const item of listOf(value)) this.put(element, item);
      this.setU32(lengthAt, this.bytes.length - start);
    } else if (code === "(" || code === "{") {
      this.pad(8);
      const fields = completeTypes(type.slice(1, -1));
      const values = listOf(value);
      if (values.length !== fields.length) throw new Error("A D-Bus struct has the wrong fields.");
      fields.forEach((field, index) => this.put(field, values[index] ?? 0));
    } else throw new Error("A D-Bus value this does not write.");
  }
}

/** A method call, little-endian, as the bus reads it. */
export function encodeCall(serial: number, call: BusCall): Buffer {
  const body = new Writer();
  const types = completeTypes(call.signature ?? "");
  const values = call.body ?? [];
  if (values.length !== types.length) throw new Error("A D-Bus call has the wrong arguments.");
  types.forEach((type, index) => body.put(type, values[index] ?? 0));
  const header = new Writer();
  header.bytes.push(0x6c, METHOD_CALL, 0, 1);
  header.u32(body.bytes.length);
  header.u32(serial);
  header.u32(0);
  const fields: Array<readonly [number, string, string]> = [
    [1, "o", call.path],
    [2, "s", call.iface],
    [3, "s", call.member],
    [6, "s", call.destination],
  ];
  if (call.signature) fields.push([8, "g", call.signature]);
  const start = header.bytes.length;
  for (const [code, type, value] of fields) {
    header.pad(8);
    header.bytes.push(code);
    header.put("g", type);
    header.put(type, value);
  }
  header.setU32(12, header.bytes.length - start);
  header.pad(8);
  return Buffer.from([...header.bytes, ...body.bytes]);
}

class Reader {
  readonly data: Buffer;
  readonly little: boolean;
  at: number;
  readonly end: number;
  constructor(data: Buffer, little: boolean, at: number, end: number) {
    this.data = data;
    this.little = little;
    this.at = at;
    this.end = end;
  }
  need(bytes: number) {
    if (this.at + bytes > this.end) throw new Error("A D-Bus message ended early.");
  }
  pad(n: number) {
    this.at += (n - (this.at % n)) % n;
    this.need(0);
  }
  u32() {
    this.pad(4);
    this.need(4);
    const value = this.little ? this.data.readUInt32LE(this.at) : this.data.readUInt32BE(this.at);
    this.at += 4;
    return value;
  }
  text(length: number, encoding: "utf8" | "ascii") {
    this.need(length + 1);
    if (this.data[this.at + length] !== 0) throw new Error("A D-Bus string is not terminated.");
    const value = this.data.toString(encoding, this.at, this.at + length);
    this.at += length + 1;
    return value;
  }
  take(type: string): DbusValue {
    const code = type[0];
    if (code === "y") {
      this.need(1);
      return this.data[this.at++] ?? 0;
    }
    if (code === "b") {
      const value = this.u32();
      if (value > 1) throw new Error("A D-Bus boolean is neither 0 nor 1.");
      return value === 1;
    }
    if (code === "u") return this.u32();
    if (code === "i") return this.u32() | 0;
    if (code === "s" || code === "o") return this.text(this.u32(), "utf8");
    if (code === "g") {
      this.need(1);
      return this.text(this.data[this.at++] ?? 0, "ascii");
    }
    if (code === "v") {
      const inner = completeTypes(String(this.take("g")));
      if (inner.length !== 1 || inner[0] === undefined)
        throw new Error("A D-Bus variant holds more than one type.");
      return this.take(inner[0]);
    }
    if (code === "a") {
      const length = this.u32();
      const element = type.slice(1);
      this.pad(alignment(element));
      this.need(length);
      const stop = this.at + length;
      const items: DbusValue[] = [];
      while (this.at < stop) items.push(this.take(element));
      if (this.at !== stop) throw new Error("A D-Bus array ran past its length.");
      return items;
    }
    if (code === "(" || code === "{") {
      this.pad(8);
      return completeTypes(type.slice(1, -1)).map((field) => this.take(field));
    }
    throw new Error("A D-Bus type this does not read.");
  }
}

export interface Message {
  readonly type: number;
  readonly serial: number;
  readonly member?: string;
  readonly replySerial?: number;
  readonly errorName?: string;
  readonly signature: string;
  /** The body read by its signature; an Error when it holds a type this does not read. */
  readonly body: ReadonlyArray<DbusValue> | Error;
}

/** The next whole message in data and its length, undefined while it is still arriving. */
export function decodeMessage(
  data: Buffer,
): { readonly message: Message; readonly length: number } | undefined {
  if (data.length < 16) return undefined;
  const little = data[0] === 0x6c;
  if (!little && data[0] !== 0x42) throw new Error("Not a D-Bus message.");
  const u32 = (at: number) => (little ? data.readUInt32LE(at) : data.readUInt32BE(at));
  const fieldsEnd = 16 + u32(12);
  const bodyStart = fieldsEnd + ((8 - (fieldsEnd % 8)) % 8);
  const length = bodyStart + u32(4);
  if (length > MAX_MESSAGE_BYTES) throw new Error("A D-Bus message is too large.");
  if (data.length < length) return undefined;
  const header = new Reader(data, little, 12, fieldsEnd);
  const fields = new Map<number, DbusValue>();
  for (const field of listOf(header.take("a(yv)"))) {
    const [code, value] = listOf(field);
    if (typeof code === "number" && value !== undefined) fields.set(code, value);
  }
  const replySerial = fields.get(5);
  const errorName = fields.get(4);
  const member = fields.get(3);
  const signature = fields.get(8);
  const types = typeof signature === "string" ? signature : "";
  let body: ReadonlyArray<DbusValue> | Error;
  try {
    const reader = new Reader(data, little, bodyStart, length);
    body = completeTypes(types).map((type) => reader.take(type));
    if (reader.at !== length) throw new Error("A D-Bus body is longer than its signature.");
  } catch (error) {
    body = error instanceof Error ? error : new Error(String(error));
  }
  return {
    message: {
      type: data[1] ?? 0,
      serial: u32(8),
      ...(typeof member === "string" ? { member } : {}),
      ...(typeof replySerial === "number" ? { replySerial } : {}),
      ...(typeof errorName === "string" ? { errorName } : {}),
      signature: types,
      body,
    },
    length,
  };
}

interface Connection {
  readonly socket: NodeNet.Socket;
  readonly send: (call: BusCall) => Promise<BusReply>;
  readonly pending: () => number;
}

function connect(path: string, uid: number): Promise<Connection> {
  return new Promise((resolve, reject) => {
    const socket = NodeNet.createConnection({ path });
    let buffered = Buffer.alloc(0);
    let authenticated = false;
    let serial = 0;
    const replies = new Map<
      number,
      { resolve: (reply: BusReply) => void; reject: (error: Error) => void }
    >();
    const setup = setTimeout(
      () => fail(new Error("The accessibility bus did not let this in.")),
      SETUP_TIMEOUT_MS,
    );
    setup.unref();
    const fail = (error: Error) => {
      clearTimeout(setup);
      for (const waiter of replies.values()) waiter.reject(error);
      socket.destroy();
      reject(error);
    };
    const send = (call: BusCall) =>
      new Promise<BusReply>((done, refuse) => {
        if (socket.destroyed) return refuse(new Error("The accessibility bus connection ended."));
        const id = ++serial;
        // A call in flight keeps the process up; an idle connection never does.
        const settle = () => {
          clearTimeout(timer);
          replies.delete(id);
          if (replies.size === 0) socket.unref();
        };
        const timer = setTimeout(() => {
          settle();
          refuse(new Error("The accessibility bus did not answer " + call.member + "."));
        }, CALL_TIMEOUT_MS);
        timer.unref();
        replies.set(id, {
          resolve: (reply) => {
            settle();
            done(reply);
          },
          reject: (error) => {
            settle();
            refuse(error);
          },
        });
        socket.ref();
        socket.write(encodeCall(id, call));
      });
    const connection = { socket, send, pending: () => replies.size };
    socket.on("connect", () => {
      socket.write("\0AUTH EXTERNAL " + Buffer.from(String(uid), "ascii").toString("hex") + "\r\n");
    });
    socket.on("data", (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      try {
        if (!authenticated) {
          const end = buffered.indexOf("\r\n");
          if (end < 0) {
            if (buffered.length > 512)
              throw new Error("The accessibility bus sent no auth answer.");
            return;
          }
          if (!buffered.toString("ascii", 0, end).startsWith("OK "))
            throw new Error("The accessibility bus refused this process.");
          buffered = buffered.subarray(end + 2);
          authenticated = true;
          socket.write("BEGIN\r\n");
          send({
            destination: "org.freedesktop.DBus",
            path: "/org/freedesktop/DBus",
            iface: "org.freedesktop.DBus",
            member: "Hello",
          }).then(
            () => {
              clearTimeout(setup);
              resolve(connection);
            },
            (error: unknown) => fail(error instanceof Error ? error : new Error(String(error))),
          );
        }
        for (let next = decodeMessage(buffered); next; next = decodeMessage(buffered)) {
          buffered = buffered.subarray(next.length);
          const { message } = next;
          if (message.type !== METHOD_RETURN && message.type !== ERROR) continue;
          const waiter =
            message.replySerial === undefined ? undefined : replies.get(message.replySerial);
          if (waiter === undefined || message.replySerial === undefined) continue;
          if (message.body instanceof Error) waiter.reject(message.body);
          else if (message.type === ERROR)
            waiter.reject(
              new BusError(
                message.errorName ?? "",
                typeof message.body[0] === "string" ? message.body[0] : "",
              ),
            );
          else waiter.resolve({ signature: message.signature, body: message.body });
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", (error) => fail(error));
    socket.on("close", () => fail(new Error("The accessibility bus connection ended.")));
  });
}

/**
 * Calls on the accessibility bus at `address`, over one connection opened at the first call,
 * opened again after it ends, and closed after a while without calls.
 */
export function makeAtspiBus(options: {
  readonly address: () => Promise<string>;
  readonly uid: number;
}): AtspiCall {
  let current: Promise<Connection> | undefined;
  let idle: ReturnType<typeof setTimeout> | undefined;
  const connection = () => {
    if (current !== undefined) return current;
    const attempt = (async () => {
      const path = busSocketPath(await options.address());
      if (path === undefined) throw new Error("The accessibility bus has no unix socket.");
      return connect(path, options.uid);
    })();
    current = attempt;
    const forget = () => {
      if (current === attempt) current = undefined;
    };
    attempt.then((opened) => opened.socket.on("close", forget), forget);
    return attempt;
  };
  // The calls only read, so one sent on a connection the bus has just dropped is sent again.
  return async (call) => {
    if (idle !== undefined) clearTimeout(idle);
    for (let retried = false; ; retried = true) {
      const attempt = connection();
      const opened = await attempt;
      try {
        return await opened.send(call);
      } catch (error) {
        if (retried || !opened.socket.destroyed) throw error;
        if (current === attempt) current = undefined;
      } finally {
        if (opened.pending() === 0) {
          if (idle !== undefined) clearTimeout(idle);
          idle = setTimeout(() => {
            if (current === attempt) current = undefined;
            opened.socket.end();
          }, IDLE_CLOSE_MS);
          idle.unref();
        }
      }
    }
  };
}
