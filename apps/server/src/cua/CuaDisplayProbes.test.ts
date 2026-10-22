// @effect-diagnostics nodeBuiltinImport:off -- fake X and D-Bus servers need raw Unix sockets.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { dbusMethodCall, dbusParseMessages, dbusSocketPath, dbusAuthLine } from "./CuaDbusProbe.ts";
import {
  chooseX11Auth,
  probeAccessibilityBuses,
  unixSocketAccepts,
} from "./CuaDisplayCapability.ts";

/** A METHOD_RETURN, serial 3, reply_serial 1, body ":1.7", assembled by hand from the spec. */
const HELLO_REPLY = Uint8Array.from([
  0x6c, 2, 1, 1, 9, 0, 0, 0, 3, 0, 0, 0, 15, 0, 0, 0, 5, 1, 0x75, 0, 1, 0, 0, 0, 8, 1, 0x67, 0, 1,
  0x73, 0, 0, 4, 0, 0, 0, 0x3a, 0x31, 0x2e, 0x37, 0,
]);

/** A reply the fake bus sends; strings only, like org.a11y.Bus.GetAddress. */
function reply(type: 2 | 3, replySerial: number, text: string): Buffer {
  const body = Buffer.from(text);
  const signature = type === 2 ? "s" : "s";
  const fields = [
    5,
    1,
    0x75,
    0,
    replySerial,
    0,
    0,
    0,
    8,
    1,
    0x67,
    0,
    1,
    signature.charCodeAt(0),
    0,
  ];
  if (type === 3) fields.push(0, 4, 1, 0x73, 0, 4, 0, 0, 0, ...Buffer.from("e.x"), 0);
  const header = [
    0x6c,
    type,
    1,
    1,
    ...u32(4 + body.length + 1),
    ...u32(9),
    ...u32(fields.length),
    ...fields,
  ];
  while (header.length % 8 !== 0) header.push(0);
  return Buffer.from([...header, ...u32(body.length), ...body, 0]);
}
const u32 = (value: number) => [
  value & 0xff,
  (value >>> 8) & 0xff,
  (value >>> 16) & 0xff,
  value >>> 24,
];

const temporaryDirectory = Effect.acquireRelease(
  Effect.sync(() => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "goat-cua-"))),
  (directory) => Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
);

const listen = (socketPath: string, onConnection: (socket: NodeNet.Socket) => void) =>
  Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer(onConnection);
      server.listen(socketPath, () => resume(Effect.succeed(server)));
    }),
    (server) => Effect.callback<void>((resume) => void server.close(() => resume(Effect.void))),
  );

/** Accepts the X11 setup only when it carries `cookie`. */
const fakeXServer = (socketPath: string, cookie: Uint8Array) =>
  listen(socketPath, (socket) =>
    socket.once("data", (request: Buffer) => {
      socket.end(Buffer.from([request.includes(Buffer.from(cookie)) ? 1 : 0]));
    }),
  );

/** Authenticates anyone, answers Hello, and answers the second call with `second`. */
const fakeBus = (socketPath: string, second: { type: 2 | 3; text: string }) =>
  listen(socketPath, (socket) => {
    let pending = Buffer.alloc(0);
    let authenticated = false;
    let calls = 0;
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      if (!authenticated) {
        const end = pending.indexOf("\r\n");
        if (end < 0) return;
        if (!pending.subarray(0, end).toString().startsWith("\0AUTH EXTERNAL "))
          return socket.end();
        socket.write("OK 0123456789abcdef0123456789abcdef\r\n");
        authenticated = true;
        pending = pending.subarray(end + 2);
      }
      if (pending.subarray(0, 7).toString() === "BEGIN\r\n") pending = pending.subarray(7);
      const { messages, consumed } = dbusParseMessages(pending);
      pending = pending.subarray(consumed);
      for (const message of messages) {
        if (message.type !== 1) continue;
        calls += 1;
        socket.write(calls === 1 ? reply(2, 1, ":1.7") : reply(second.type, 2, second.text));
      }
    });
  });

describe("D-Bus wire format", () => {
  it("reads a hand-assembled method return", () => {
    expect(dbusParseMessages(HELLO_REPLY)).toEqual({
      messages: [{ type: 2, replySerial: 1, text: ":1.7" }],
      consumed: HELLO_REPLY.length,
    });
    expect(dbusParseMessages(HELLO_REPLY.subarray(0, 30)).messages).toEqual([]);
    // A nine-byte body leaves the next message at an odd offset.
    const two = Uint8Array.from([...HELLO_REPLY, ...HELLO_REPLY]);
    expect(dbusParseMessages(two).messages).toEqual([
      { type: 2, replySerial: 1, text: ":1.7" },
      { type: 2, replySerial: 1, text: ":1.7" },
    ]);
  });

  it("writes method calls padded to eight bytes with every header field", () => {
    const call = dbusMethodCall({
      serial: 2,
      destination: "org.a11y.Bus",
      path: "/org/a11y/bus",
      interface: "org.a11y.Bus",
      member: "GetAddress",
    });
    expect([call[0], call[1], call[3]]).toEqual([0x6c, 1, 1]);
    expect(call.length % 8).toBe(0);
    expect(dbusParseMessages(call).messages).toEqual([{ type: 1, replySerial: null, text: null }]);
    for (const text of ["/org/a11y/bus", "org.a11y.Bus", "GetAddress"])
      expect(Buffer.from(call).includes(Buffer.from(text))).toBe(true);
  });

  it("dials unix path and abstract addresses and authenticates as the uid", () => {
    expect(dbusSocketPath("unix:path=/run/user/0/bus")).toBe("/run/user/0/bus");
    expect(dbusSocketPath("unix:abstract=/tmp/dbus-x,guid=12")).toBe("\0/tmp/dbus-x");
    expect(dbusSocketPath("tcp:host=localhost,port=1;unix:path=/b")).toBe("/b");
    expect(dbusSocketPath("tcp:host=localhost,port=1")).toBeNull();
    expect(dbusAuthLine(1000)).toBe("\0AUTH EXTERNAL 31303030\r\n");
  });
});

describe("live probes", () => {
  it.live("tries every Xauthority cookie and keeps the one the X server accepts", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      const socket = NodePath.join(directory, "X1");
      const good = Uint8Array.from({ length: 16 }, (_, index) => index + 1);
      yield* fakeXServer(socket, good);
      const stale = { file: "/home/root/.Xauthority", cookie: new Uint8Array(16).fill(9) };
      const valid = { file: "/tmp/xvfb-run.Qx81/Xauthority", cookie: good };
      expect(yield* chooseX11Auth(socket, [stale, valid])).toEqual({
        outcome: "ok",
        xauthority: valid.file,
      });
      expect(yield* chooseX11Auth(socket, [stale])).toEqual({
        outcome: "refused",
        xauthority: null,
      });
    }).pipe(Effect.scoped),
  );

  it.live("accepts a session bus only when it answers, then checks the AT-SPI bus it names", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      const session = NodePath.join(directory, "bus");
      const a11y = NodePath.join(directory, "at-spi");
      const dead = NodePath.join(directory, "gone");
      yield* fakeBus(session, { type: 2, text: `unix:path=${a11y}` });
      yield* fakeBus(a11y, { type: 2, text: "unused" });
      expect(
        yield* probeAccessibilityBuses([`unix:path=${dead}`, `unix:path=${session}`], 1000),
      ).toEqual({ sessionBus: `unix:path=${session}`, atSpi: true, issues: [] });
      expect(yield* probeAccessibilityBuses([`unix:path=${dead}`], 1000)).toEqual({
        sessionBus: null,
        atSpi: false,
        issues: [`the D-Bus session bus at unix:path=${dead} does not answer`],
      });
    }).pipe(Effect.scoped),
  );

  it.live(
    "reports AT-SPI missing when the session bus has no org.a11y.Bus or its bus is gone",
    () =>
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory;
        const noA11y = NodePath.join(directory, "bus1");
        const goneA11y = NodePath.join(directory, "bus2");
        yield* fakeBus(noA11y, {
          type: 3,
          text: "org.a11y.Bus was not provided by any .service files",
        });
        yield* fakeBus(goneA11y, {
          type: 2,
          text: `unix:path=${NodePath.join(directory, "nobody")}`,
        });
        expect(yield* probeAccessibilityBuses([`unix:path=${noA11y}`], 0)).toEqual({
          sessionBus: `unix:path=${noA11y}`,
          atSpi: false,
          issues: ["AT-SPI (at-spi2-core) is not available on the session bus"],
        });
        const gone = yield* probeAccessibilityBuses([`unix:path=${goneA11y}`], 0);
        expect(gone.atSpi).toBe(false);
        expect(gone.issues[0]).toContain("does not answer");
      }).pipe(Effect.scoped),
  );

  it.live("sees whether a Wayland socket accepts connections", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory;
      const socket = NodePath.join(directory, "wayland-0");
      yield* listen(socket, (connection) => connection.end());
      expect(yield* unixSocketAccepts(socket)).toBe(true);
      expect(yield* unixSocketAccepts(NodePath.join(directory, "wayland-1"))).toBe(false);
    }).pipe(Effect.scoped),
  );
});
