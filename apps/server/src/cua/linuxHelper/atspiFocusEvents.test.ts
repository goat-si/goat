// @effect-diagnostics nodeBuiltinImport:off -- A scripted D-Bus peer needs a real unix socket.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import {
  busSocketPath,
  isFocusChange,
  methodCall,
  openFocusEvents,
  readMessage,
} from "./atspiFocusEvents.ts";

// Signals a GTK3 and a GTK4 app sent on a GNOME 46 accessibility bus when a password field took
// focus, byte for byte.
const signals = JSON.parse(
  NodeFS.readFileSync(new URL("./fixtures/atspi-focus-signals.json", import.meta.url), "utf8"),
) as { readonly gtk3: string; readonly gtk4: string };
const GTK3 = Buffer.from(signals.gtk3, "hex");
const GTK4 = Buffer.from(signals.gtk4, "hex");

/** A reply to serial; an error carries its message as the body's string. */
function reply(serial: number, error?: string): Buffer {
  const fields: number[] = [];
  const pad = (n: number) => {
    while ((16 + fields.length) % n !== 0) fields.push(0);
  };
  const u32 = (value: number) =>
    fields.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
  const body: number[] = [];
  if (error !== undefined) {
    const name = Buffer.from("org.freedesktop.DBus.Error.InvalidArgs");
    pad(8);
    fields.push(4, 1, 0x73, 0);
    u32(name.length);
    fields.push(...name, 0);
    const text = Buffer.from(error);
    body.push(text.length & 0xff, (text.length >>> 8) & 0xff, 0, 0, ...text, 0);
  }
  pad(8);
  fields.push(5, 1, 0x75, 0);
  u32(serial);
  if (error !== undefined) {
    pad(8);
    fields.push(8, 1, 0x67, 0, 1, 0x73, 0);
  }
  const header = Buffer.alloc(16);
  header.write("l", 0);
  header[1] = error === undefined ? 2 : 3;
  header[3] = 1;
  header.writeUInt32LE(body.length, 4);
  header.writeUInt32LE(9_000 + serial, 8);
  header.writeUInt32LE(fields.length, 12);
  const message = [...header, ...fields];
  while (message.length % 8 !== 0) message.push(0);
  return Buffer.from([...message, ...body]);
}

/** A bus that authenticates any client, answers its calls, and records what it was asked. */
async function scriptedBus(
  refuse: (
    member: string,
    firstString: string | undefined,
    signature: string | undefined,
  ) => boolean,
) {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-a11y-bus-"));
  const path = NodePath.join(dir, "bus");
  const calls: string[] = [];
  const clients: NodeNet.Socket[] = [];
  const registered: Array<() => void> = [];
  const server = NodeNet.createServer((socket) => {
    clients.push(socket);
    let data = Buffer.alloc(0);
    let stage: "auth" | "begin" | "messages" = "auth";
    socket.on("data", (chunk: Buffer) => {
      data = Buffer.concat([data, chunk]);
      while (stage !== "messages") {
        const end = data.indexOf("\r\n");
        if (end < 0) return;
        const line = data.toString("ascii", 0, end);
        data = data.subarray(end + 2);
        if (stage === "auth") {
          calls.push(line);
          socket.write("OK 0123456789abcdef0123456789abcdef\r\n");
          stage = "begin";
        } else if (line === "BEGIN") stage = "messages";
      }
      for (let next = readMessage(data); next; next = readMessage(data)) {
        data = data.subarray(next.length);
        const { message } = next;
        calls.push(message.member + "(" + (message.signature ?? "") + ")");
        const refused = refuse(message.member ?? "", message.firstString, message.signature);
        socket.write(reply(message.serial, refused ? "refused" : undefined));
        if (
          !refused &&
          message.member === "RegisterEvent" &&
          message.firstString === "window:activate"
        )
          registered.shift()?.();
      }
    });
    socket.on("error", () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(path, resolve));
  return {
    address: "unix:path=" + path.replaceAll(",", "%2c") + ",guid=0123",
    calls,
    clients,
    /** Resolves once a client has registered its last event. */
    registration: () => {
      const done = Promise.withResolvers<void>();
      registered.push(done.resolve);
      return done.promise;
    },
    close: () => {
      for (const client of clients) client.destroy();
      server.close();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("AT-SPI focus events", () => {
  it("reads the focus signals GTK3 and GTK4 send, and nothing else, as focus changes", () => {
    for (const signal of [GTK3, GTK4]) {
      const read = readMessage(signal);
      expect(read?.length).toBe(signal.length);
      expect(read && isFocusChange(read.message)).toBe(true);
    }
    // A signal still arriving is not read yet.
    expect(readMessage(GTK3.subarray(0, GTK3.length - 1))).toBeUndefined();
    const call = readMessage(
      methodCall(7, {
        destination: "org.a11y.atspi.Registry",
        path: "/org/a11y/atspi/registry",
        iface: "org.a11y.atspi.Registry",
        member: "RegisterEvent",
        args: ["object:state-changed:focused", [], ""],
      }),
    );
    expect(call?.message).toMatchObject({
      type: 1,
      serial: 7,
      member: "RegisterEvent",
      signature: "sass",
      firstString: "object:state-changed:focused",
    });
    expect(call && isFocusChange(call.message)).toBe(false);
  });

  it("skips header fields of codes it does not use when their type is basic, as the spec asks (#1650)", () => {
    const bytes: number[] = [];
    const pad = (n: number) => {
      while (bytes.length % n !== 0) bytes.push(0);
    };
    const u32 = (value: number) => {
      pad(4);
      bytes.push(value & 0xff, (value >>> 8) & 0xff, (value >>> 16) & 0xff, value >>> 24);
    };
    const field = (code: number, type: string, write: () => void) => {
      pad(8);
      bytes.push(code, 1, type.charCodeAt(0), 0);
      write();
    };
    const text = (value: string) => {
      u32(Buffer.byteLength(value));
      bytes.push(...Buffer.from(value), 0);
    };
    bytes.push(0x6c, 4, 1, 1);
    u32(0);
    u32(5);
    u32(0);
    const start = bytes.length;
    field(1, "o", () => text("/org/a11y/atspi/accessible/3"));
    // Unknown codes holding an INT32 and an INT64.
    field(42, "i", () => u32(7));
    field(43, "x", () => {
      pad(8);
      bytes.push(1, 0, 0, 0, 0, 0, 0, 0);
    });
    field(2, "s", () => text("org.a11y.atspi.Event.Object"));
    field(3, "s", () => text("StateChanged"));
    field(8, "g", () => bytes.push(9, ...Buffer.from("siiva{sv}"), 0));
    const fieldsLength = bytes.length - start;
    pad(8);
    const bodyStart = bytes.length;
    text("focused");
    pad(4);
    bytes.push(1, 0, 0, 0, 0, 0, 0, 0);
    bytes.push(1, 0x73, 0, 0);
    text("");
    pad(4);
    bytes.push(0, 0, 0, 0);
    const signal = Buffer.from(bytes);
    signal.writeUInt32LE(bytes.length - bodyStart, 4);
    signal.writeUInt32LE(fieldsLength, 12);
    const read = readMessage(signal);
    expect(read?.length).toBe(signal.length);
    expect(read && isFocusChange(read.message)).toBe(true);
  });

  it("finds the socket of a unix bus address, escaped or abstract", () => {
    expect(busSocketPath("unix:path=/run/user/1000/at-spi/bus,guid=ab")).toBe(
      "/run/user/1000/at-spi/bus",
    );
    expect(busSocketPath("tcp:host=x;unix:abstract=/tmp/dbus-x%2cy")).toBe("\0/tmp/dbus-x,y");
    expect(busSocketPath("tcp:host=localhost,port=1")).toBeUndefined();
  });

  it("registers for focus events on its own connection, hears GTK3 and GTK4, and reconnects when the bus drops (#1638)", async () => {
    // A registry that only knows the two-argument RegisterEvent.
    const bus = await scriptedBus(
      (member, _first, signature) => member === "RegisterEvent" && signature === "sass",
    );
    const heard: Array<() => void> = [];
    const hear = () => {
      const done = Promise.withResolvers<void>();
      heard.push(done.resolve);
      return done.promise;
    };
    const retry = Promise.withResolvers<void>();
    const events = openFocusEvents({
      address: async () => bus.address,
      uid: 1000,
      retry: () => retry.promise,
    });
    const stop = events.subscribe(() => heard.shift()?.());
    try {
      // On connecting it reports a change it may have missed while down.
      const connected = hear();
      await bus.registration();
      await connected;
      expect(bus.calls).toEqual([
        "\0AUTH EXTERNAL 31303030",
        "Hello()",
        "AddMatch(s)",
        "AddMatch(s)",
        "RegisterEvent(sass)",
        "RegisterEvent(sas)",
        "RegisterEvent(sass)",
        "RegisterEvent(sas)",
      ]);
      const fromGtk3 = hear();
      bus.clients[0]?.write(GTK3);
      await fromGtk3;
      // The bus restarts; the next connection registers again and hears GTK4.
      const again = bus.registration();
      const reconnected = hear();
      bus.clients[0]?.destroy();
      retry.resolve();
      await again;
      await reconnected;
      const fromGtk4 = hear();
      bus.clients[1]?.write(GTK4);
      await fromGtk4;
      expect(bus.clients).toHaveLength(2);
    } finally {
      stop();
      events.close();
      bus.close();
    }
  });

  it("drops a bus that never answers authentication at the setup limit, retries, and closes a connection still authenticating (#1644 r1)", async () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-a11y-silent-"));
    const path = NodePath.join(dir, "bus");
    const arrivals: Array<(socket: NodeNet.Socket) => void> = [];
    const arrived = () =>
      new Promise<NodeNet.Socket>((resolve) => {
        arrivals.push(resolve);
      });
    // Accepts every connection and never says anything.
    const server = NodeNet.createServer((socket) => {
      socket.on("error", () => undefined);
      arrivals.shift()?.(socket);
    });
    await new Promise<void>((resolve) => server.listen(path, resolve));
    const limit = Promise.withResolvers<void>();
    // Only the first connection's setup limit passes; the second waits on close alone.
    const limits = [limit.promise, new Promise<void>(() => undefined)];
    const retried = Promise.withResolvers<void>();
    const retry = Promise.withResolvers<void>();
    const closedSocket = (socket: NodeNet.Socket) =>
      new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
      });
    const firstArrival = arrived();
    const events = openFocusEvents({
      address: async () => "unix:path=" + path,
      uid: 1000,
      setupLimit: () => limits.shift() ?? new Promise<void>(() => undefined),
      retry: () => {
        retried.resolve();
        return retry.promise;
      },
    });
    const stopListening = events.subscribe(() => undefined);
    try {
      const first = await firstArrival;
      const firstClosed = closedSocket(first);
      limit.resolve();
      await firstClosed;
      await retried.promise;
      const secondArrival = arrived();
      retry.resolve();
      // Closing must end a connection that is still waiting for its auth answer.
      const second = await secondArrival;
      const secondClosed = closedSocket(second);
      events.close();
      await secondClosed;
    } finally {
      stopListening();
      events.close();
      server.close();
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("connects only while someone listens, and leaving drops the registration (#1650)", async () => {
    const bus = await scriptedBus(() => false);
    const retry = Promise.withResolvers<void>();
    const events = openFocusEvents({
      address: async () => bus.address,
      uid: 1000,
      retry: () => retry.promise,
    });
    try {
      const first = bus.registration();
      const stop = events.subscribe(() => undefined);
      await first;
      expect(bus.clients).toHaveLength(1);
      const dropped = new Promise<void>((resolve) => {
        bus.clients[0]?.once("close", () => resolve());
      });
      stop();
      await dropped;
      // Listening again registers again on a new connection.
      const second = bus.registration();
      const stopAgain = events.subscribe(() => undefined);
      retry.resolve();
      await second;
      expect(bus.clients).toHaveLength(2);
      stopAgain();
    } finally {
      events.close();
      bus.close();
    }
  });
});
