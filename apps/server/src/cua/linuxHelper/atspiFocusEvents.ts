// @effect-diagnostics nodeBuiltinImport:off -- The Linux helper is its own Node process; D-Bus needs a raw socket.
// @effect-diagnostics globalTimers:off -- Request deadlines at socket callback boundaries.
import * as NodeNet from "node:net";

/**
 * Focus changes from the AT-SPI bus, as they happen (#1638). The focus probe (atspiFocus.ts)
 * answers for one moment; a password field that takes focus right after it would wait for the
 * next tick. This keeps one connection to the accessibility bus and calls the listeners on every
 * focus change any app reports, so the monitor probes again at once.
 *
 * GTK3 (atk-bridge) sends these events only while a listener is registered with the AT-SPI
 * registry, and the registry forgets a listener when its connection closes, so the registration
 * and the match rules live on this one connection; a gdbus monitor alone hears nothing from
 * GTK3. GTK4 sends them either way. The connection carries only that a focus changed, never
 * what was typed. When it drops, the monitor still polls, and this reconnects.
 */

export interface FocusEvents {
  /** Calls listener on every focus change; returns the function that stops it. */
  readonly subscribe: (listener: () => void) => () => void;
  readonly close: () => void;
}

export interface FocusEventsDependencies {
  /** The accessibility bus address, from org.a11y.Bus.GetAddress; read again on reconnect. */
  readonly address: () => Promise<string>;
  readonly uid: number;
  /** Resolves when the next connection attempt may start. */
  readonly retry: () => Promise<void>;
  /** Resolves when a connection still authenticating or registering has taken too long. */
  readonly setupLimit?: () => Promise<void>;
}

const EVENTS = ["object:state-changed:focused", "window:activate"];
const RULES = [
  "type='signal',interface='org.a11y.atspi.Event.Object',member='StateChanged',arg0='focused'",
  "type='signal',interface='org.a11y.atspi.Event.Window',member='Activate'",
];
const CALL_TIMEOUT_MS = 2_000;
/** Authentication and registration together; a bus that stalls longer is dropped and retried. */
const SETUP_TIMEOUT_MS = 5_000;
/** Far above any focus signal; a larger message means the stream is not what this expects. */
const MAX_MESSAGE_BYTES = 1 << 20;

const METHOD_CALL = 1;
const METHOD_RETURN = 2;
const ERROR = 3;
const SIGNAL = 4;

/** The socket path of the first unix: entry of a D-Bus address; abstract names start with NUL. */
export function busSocketPath(address: string): string | undefined {
  for (const entry of address.split(";")) {
    const colon = entry.indexOf(":");
    if (colon < 0 || entry.slice(0, colon) !== "unix") continue;
    const keys = new Map<string, string>();
    for (const pair of entry.slice(colon + 1).split(",")) {
      const equals = pair.indexOf("=");
      if (equals > 0) keys.set(pair.slice(0, equals), unescapeValue(pair.slice(equals + 1)));
    }
    const path = keys.get("path");
    if (path) return path;
    const abstract = keys.get("abstract");
    if (abstract) return "\0" + abstract;
  }
  return undefined;
}

function unescapeValue(value: string): string {
  return value.replace(/%([0-9A-Fa-f]{2})/gu, (_, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
}

class Writer {
  readonly bytes: number[] = [];
  align(n: number) {
    while (this.bytes.length % n !== 0) this.bytes.push(0);
  }
  byte(value: number) {
    this.bytes.push(value & 0xff);
  }
  u32(value: number) {
    this.align(4);
    this.bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
  }
  string(value: string) {
    const encoded = Buffer.from(value, "utf8");
    this.u32(encoded.length);
    this.bytes.push(...encoded, 0);
  }
  signature(value: string) {
    this.byte(value.length);
    this.bytes.push(...Buffer.from(value, "ascii"), 0);
  }
}

export type CallArgument = string | ReadonlyArray<string>;

/** A little-endian method call; arguments are strings or string arrays. */
export function methodCall(
  serial: number,
  call: {
    readonly destination: string;
    readonly path: string;
    readonly iface: string;
    readonly member: string;
    readonly args?: ReadonlyArray<CallArgument>;
  },
): Buffer {
  const args = call.args ?? [];
  const body = new Writer();
  for (const arg of args) {
    if (typeof arg === "string") body.string(arg);
    else {
      body.u32(0);
      const lengthAt = body.bytes.length - 4;
      const start = body.bytes.length;
      for (const item of arg) body.string(item);
      const length = body.bytes.length - start;
      body.bytes.splice(
        lengthAt,
        4,
        length & 0xff,
        (length >>> 8) & 0xff,
        (length >>> 16) & 0xff,
        length >>> 24,
      );
    }
  }
  const signature = args.map((arg) => (typeof arg === "string" ? "s" : "as")).join("");
  const fields: Array<readonly [number, "o" | "s" | "g", string]> = [
    [1, "o", call.path],
    [2, "s", call.iface],
    [3, "s", call.member],
    [6, "s", call.destination],
  ];
  if (signature) fields.push([8, "g", signature]);
  const header = new Writer();
  header.byte(0x6c);
  header.byte(METHOD_CALL);
  header.byte(0);
  header.byte(1);
  header.u32(body.bytes.length);
  header.u32(serial);
  header.u32(0);
  const start = header.bytes.length;
  for (const [code, type, value] of fields) {
    header.align(8);
    header.byte(code);
    header.signature(type);
    if (type === "g") header.signature(value);
    else header.string(value);
  }
  const length = header.bytes.length - start;
  header.bytes.splice(
    12,
    4,
    length & 0xff,
    (length >>> 8) & 0xff,
    (length >>> 16) & 0xff,
    length >>> 24,
  );
  header.align(8);
  return Buffer.from([...header.bytes, ...body.bytes]);
}

export interface Message {
  readonly type: number;
  readonly serial: number;
  readonly replySerial?: number;
  readonly iface?: string;
  readonly member?: string;
  readonly signature?: string;
  /** The body's first string, when the body starts with one. */
  readonly firstString?: string;
}

const align = (at: number, n: number) => at + ((n - (at % n)) % n);

/**
 * The next whole message at the start of data and its length, or undefined while it is still
 * arriving. Throws on anything this cannot read, which ends the connection.
 */
export function readMessage(
  data: Buffer,
): { readonly message: Message; readonly length: number } | undefined {
  if (data.length < 16) return undefined;
  const little = data[0] === 0x6c;
  if (!little && data[0] !== 0x42) throw new Error("Not a D-Bus message.");
  const u32 = (at: number) => {
    if (at + 4 > data.length) throw new Error("A D-Bus message ended early.");
    return little ? data.readUInt32LE(at) : data.readUInt32BE(at);
  };
  const bodyLength = u32(4);
  const fieldsLength = u32(12);
  const fieldsEnd = 16 + fieldsLength;
  const bodyStart = align(fieldsEnd, 8);
  const length = bodyStart + bodyLength;
  if (length > MAX_MESSAGE_BYTES) throw new Error("A D-Bus message is too large.");
  if (data.length < length) return undefined;
  const fields = new Map<number, string | number>();
  let at = 16;
  while (at < fieldsEnd) {
    at = align(at, 8);
    const code = data[at] ?? 0;
    const signatureLength = data[at + 1] ?? 0;
    const type = data.toString("ascii", at + 2, at + 2 + signatureLength);
    at += signatureLength + 3;
    // A field of a code this does not use is skipped when its type is basic, as the spec asks.
    if (type === "s" || type === "o") {
      at = align(at, 4);
      const size = u32(at);
      fields.set(code, data.toString("utf8", at + 4, at + 4 + size));
      at += 4 + size + 1;
    } else if (type === "g") {
      const size = data[at] ?? 0;
      fields.set(code, data.toString("ascii", at + 1, at + 1 + size));
      at += size + 2;
    } else if (type === "u" || type === "i" || type === "b" || type === "h") {
      at = align(at, 4);
      fields.set(code, u32(at));
      at += 4;
    } else if (type === "y") {
      fields.set(code, data[at] ?? 0);
      at += 1;
    } else if (type === "n" || type === "q") {
      at = align(at, 2) + 2;
    } else if (type === "x" || type === "t" || type === "d") {
      at = align(at, 8) + 8;
    } else throw new Error("A D-Bus header field this does not read.");
  }
  if (at > fieldsEnd) throw new Error("A D-Bus header ran past its length.");
  const signature = fields.get(8);
  let firstString: string | undefined;
  if (typeof signature === "string" && signature.startsWith("s") && bodyLength >= 5) {
    const size = u32(bodyStart);
    if (bodyStart + 4 + size + 1 > length) throw new Error("A D-Bus string ran past its body.");
    firstString = data.toString("utf8", bodyStart + 4, bodyStart + 4 + size);
  }
  const text = (code: number) => {
    const value = fields.get(code);
    return typeof value === "string" ? value : undefined;
  };
  const replySerial = fields.get(5);
  const iface = text(2);
  const member = text(3);
  return {
    message: {
      type: data[1] ?? 0,
      serial: u32(8),
      ...(typeof replySerial === "number" ? { replySerial } : {}),
      ...(iface === undefined ? {} : { iface }),
      ...(member === undefined ? {} : { member }),
      ...(typeof signature === "string" ? { signature } : {}),
      ...(firstString === undefined ? {} : { firstString }),
    },
    length,
  };
}

/** A focus change: a StateChanged of "focused", or a window becoming active. */
export function isFocusChange(message: Message): boolean {
  if (message.type !== SIGNAL) return false;
  if (message.iface === "org.a11y.atspi.Event.Object")
    return message.member === "StateChanged" && message.firstString === "focused";
  return message.iface === "org.a11y.atspi.Event.Window" && message.member === "Activate";
}

/**
 * One connection. Its socket is returned at once, so closing can end it at any stage; ready
 * resolves once it is registered and rejects if setup fails or outlasts setupLimit.
 */
function connectOnce(
  path: string,
  uid: number,
  setupLimit: Promise<void>,
  onFocus: () => void,
  onClose: () => void,
): { readonly socket: NodeNet.Socket; readonly ready: Promise<void> } {
  const socket = NodeNet.createConnection({ path });
  const ready = new Promise<void>((resolve, reject) => {
    let settled = false;
    let authenticated = false;
    // Set once the connection fails or closes: later calls refuse at once instead of writing to
    // a destroyed socket and arming deadlines nothing will answer.
    let ended = false;
    let pending = Buffer.alloc(0);
    let serial = 0;
    const replies = new Map<number, { resolve: () => void; reject: (error: Error) => void }>();
    const fail = (error: Error) => {
      ended = true;
      for (const waiter of replies.values()) waiter.reject(error);
      replies.clear();
      socket.destroy();
      if (!settled) {
        settled = true;
        reject(error);
      }
    };
    const call = (
      destination: string,
      objectPath: string,
      iface: string,
      member: string,
      args?: ReadonlyArray<CallArgument>,
    ) =>
      new Promise<void>((done, refuse) => {
        if (ended) {
          refuse(new Error("The accessibility bus connection ended."));
          return;
        }
        const id = ++serial;
        const timer = setTimeout(() => {
          replies.delete(id);
          refuse(new Error("The accessibility bus did not answer " + member + "."));
        }, CALL_TIMEOUT_MS);
        replies.set(id, {
          resolve: () => {
            clearTimeout(timer);
            done();
          },
          reject: (error) => {
            clearTimeout(timer);
            refuse(error);
          },
        });
        socket.write(
          methodCall(id, {
            destination,
            path: objectPath,
            iface,
            member,
            ...(args ? { args } : {}),
          }),
        );
      });
    const bus = (member: string, args?: ReadonlyArray<string>) =>
      call("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus", member, args);
    // at-spi2-core changed RegisterEvent's arguments over time; the oldest form names only the event.
    const register = async (event: string) => {
      const forms: ReadonlyArray<ReadonlyArray<CallArgument>> = [
        [event, [], ""],
        [event, []],
        [event],
      ];
      let last: Error | undefined;
      for (const args of forms) {
        if (ended) break;
        try {
          await call(
            "org.a11y.atspi.Registry",
            "/org/a11y/atspi/registry",
            "org.a11y.atspi.Registry",
            "RegisterEvent",
            args,
          );
          return;
        } catch (error) {
          last = error instanceof Error ? error : new Error(String(error));
        }
      }
      throw last ?? new Error("The AT-SPI registry refused the event.");
    };
    const setup = async () => {
      await bus("Hello");
      for (const rule of RULES) await bus("AddMatch", [rule]);
      for (const event of EVENTS) await register(event);
    };
    socket.on("connect", () => {
      socket.write("\0AUTH EXTERNAL " + Buffer.from(String(uid), "ascii").toString("hex") + "\r\n");
    });
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      try {
        if (!authenticated) {
          const end = pending.indexOf("\r\n");
          if (end < 0) {
            if (pending.length > 512) throw new Error("The accessibility bus sent no auth answer.");
            return;
          }
          const line = pending.toString("ascii", 0, end);
          pending = pending.subarray(end + 2);
          if (!line.startsWith("OK "))
            throw new Error("The accessibility bus refused this helper.");
          authenticated = true;
          socket.write("BEGIN\r\n");
          setup().then(
            () => {
              if (settled) return;
              settled = true;
              resolve();
            },
            (error: unknown) => fail(error instanceof Error ? error : new Error(String(error))),
          );
        }
        for (let next = readMessage(pending); next; next = readMessage(pending)) {
          pending = pending.subarray(next.length);
          const { message } = next;
          if (message.type === METHOD_RETURN || message.type === ERROR) {
            const waiter =
              message.replySerial === undefined ? undefined : replies.get(message.replySerial);
            if (!waiter || message.replySerial === undefined) continue;
            replies.delete(message.replySerial);
            if (message.type === METHOD_RETURN) waiter.resolve();
            else
              waiter.reject(
                new Error(message.firstString ?? "The accessibility bus refused a call."),
              );
          } else if (isFocusChange(message)) onFocus();
        }
      } catch (error) {
        fail(error instanceof Error ? error : new Error(String(error)));
      }
    });
    socket.on("error", (error) => fail(error));
    socket.on("close", () => {
      fail(new Error("The accessibility bus connection closed."));
      onClose();
    });
    void setupLimit.then(() => {
      if (!settled) fail(new Error("The accessibility bus did not finish setting up in time."));
    });
  });
  return { socket, ready };
}

export function openFocusEvents(deps: FocusEventsDependencies): FocusEvents {
  const listeners = new Set<() => void>();
  let closed = false;
  let running = false;
  let socket: NodeNet.Socket | undefined;
  const setupLimit =
    deps.setupLimit ??
    (() => new Promise<void>((resolve) => setTimeout(resolve, SETUP_TIMEOUT_MS).unref()));
  const onFocus = () => {
    for (const listener of Array.from(listeners)) listener();
  };
  // Connected only while someone listens: the registration makes every accessible app send focus
  // events, so it lasts as long as a watch does (#1650).
  const wanted = () => !closed && listeners.size > 0;
  const run = async () => {
    running = true;
    while (wanted()) {
      const closedOnce = Promise.withResolvers<void>();
      try {
        const path = busSocketPath(await deps.address());
        if (path === undefined) throw new Error("The accessibility bus address has no socket.");
        if (!wanted()) break;
        const connection = connectOnce(path, deps.uid, setupLimit(), onFocus, () =>
          closedOnce.resolve(),
        );
        socket = connection.socket;
        await connection.ready;
        // A focus change may have gone unheard while this was down.
        onFocus();
        await closedOnce.promise;
      } catch {
        // The monitor keeps polling while this is down.
      }
      socket = undefined;
      if (wanted()) await deps.retry();
    }
    running = false;
  };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      if (!running) void run();
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) socket?.destroy();
      };
    },
    close: () => {
      closed = true;
      socket?.destroy();
    },
  };
}
