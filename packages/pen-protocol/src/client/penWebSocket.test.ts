import { describe, expect, it, vi } from "vite-plus/test";
import vector from "../../vectors/session.json" with { type: "json" };
import { fromHex, toHex } from "./bytes.ts";
import { generateX25519, x25519PublicKey } from "./crypto.ts";
import { websocketAccept } from "./http1.ts";
import { Kind } from "./noise.ts";
import {
  makePenWebSocketConstructor,
  PEN_WEBSOCKET_LIMITS,
  type PenWebSocketLike,
} from "./penWebSocket.ts";
import { openSession } from "./race.ts";
import { openStream, STREAM_LIMITS } from "./stream.ts";
import { fakeFactory } from "./testing/fakeRelay.ts";
import { ManualClock } from "./testing/manualClock.ts";
import { memoryStreamPair } from "./testing/memoryStream.ts";
import { respond } from "./testing/noiseResponder.ts";

const ORIGIN = "http://goat.pen";
const latin1 = (bytes: Uint8Array) => String.fromCharCode(...bytes);

/** Unmasks client frames written to the server side, returning [opcode, payload] pairs. */
function clientFrames(
  bytes: Uint8Array,
): Array<{ fin: boolean; opcode: number; masked: boolean; mask: string; payload: Uint8Array }> {
  const out = [];
  let at = 0;
  while (at < bytes.length) {
    const b0 = bytes[at] ?? 0;
    const b1 = bytes[at + 1] ?? 0;
    let length = b1 & 0x7f;
    let p = at + 2;
    if (length === 126) {
      length = ((bytes[p] ?? 0) << 8) | (bytes[p + 1] ?? 0);
      p += 2;
    } else if (length === 127) {
      length = 0;
      for (let i = 0; i < 8; i++) length = length * 256 + (bytes[p + i] ?? 0);
      p += 8;
    }
    const mask = bytes.subarray(p, p + 4);
    p += 4;
    const payload = bytes.slice(p, p + length).map((b, i) => b ^ (mask[i & 3] ?? 0));
    out.push({
      fin: (b0 & 0x80) !== 0,
      opcode: b0 & 0x0f,
      masked: (b1 & 0x80) !== 0,
      mask: toHex(mask),
      payload,
    });
    at = p + length;
  }
  return out;
}

async function connected(options: { protocol?: string; random?: (n: number) => Uint8Array } = {}) {
  const clock = new ManualClock();
  const pair = memoryStreamPair();
  let seed = 1;
  const random = options.random ?? ((n: number) => new Uint8Array(n).fill(seed++ & 255));
  const construct = makePenWebSocketConstructor({
    origin: ORIGIN,
    openStream: async () => pair.client,
    clock,
    random,
  });
  const socket = construct("ws://goat.pen/ws?x=1", options.protocol);
  const events: Array<{ type: string; data?: unknown; code?: number }> = [];
  for (const type of ["open", "message", "error", "close"] as const) {
    socket.addEventListener(type, (event) => events.push({ type, ...event } as never));
  }
  const server = pair.server;
  await server.whenWritten(1);
  while (!latin1(server.written()).includes("\r\n\r\n"))
    await server.whenWritten(server.written().length + 1);
  const request = latin1(server.written());
  const headLength = request.indexOf("\r\n\r\n") + 4;
  const key = /Sec-WebSocket-Key: ([^\r]+)/.exec(request)?.[1] ?? "";
  const opened = new Promise<void>((resolve) =>
    socket.addEventListener("open", () => resolve(), { once: true }),
  );
  const accept = (extra = "", firstFrame = "") =>
    server.write(
      "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
        websocketAccept(key) +
        "\r\n" +
        extra +
        "\r\n" +
        firstFrame,
    );
  const framesSent = () => clientFrames(server.written().subarray(headLength));
  const whenFrames = async (n: number) => {
    while (framesSent().length < n) await server.whenWritten(server.written().length + 1);
  };
  const whenEvent = (type: string, n = 1) =>
    new Promise<void>((resolve) => {
      const check = () =>
        events.filter((e) => e.type === type).length >= n
          ? resolve()
          : socket.addEventListener(type as never, check, { once: true });
      check();
    });
  return {
    clock,
    socket,
    server,
    request,
    key,
    accept,
    opened,
    framesSent,
    whenFrames,
    events,
    whenEvent,
  };
}

describe("Pen WebSocket adapter (design 10.2 WebSocket rules on the adapter side)", () => {
  it.each([4401, 4404])(
    "an open socket whose stream the node closes %i reports close with that code once",
    async (code) => {
      const c = await connected();
      c.accept();
      await c.opened;
      c.server.close(code);
      await c.whenEvent("close");
      expect(c.events.filter((event) => event.type === "close")).toMatchObject([{ code }]);
      expect(c.socket.readyState).toBe(3);
    },
  );

  it.each([4401, 4404])(
    "over a real Pen session, a send waiting for stream credit when the node closes %i reports that code",
    async (code) => {
      const relay = "wss://relay-a.example";
      const serverPriv = fromHex(vector.responder.noisePriv);
      const serverKey = { privateKey: serverPriv, publicKey: x25519PublicKey(serverPriv) };
      let seed = 1;
      const random = (n: number) => new Uint8Array(n).fill(seed++ & 255);
      const clock = new ManualClock();
      const fake = fakeFactory();
      const pending = openSession({
        relays: [relay],
        nodeId: vector.responder.nodeId,
        serverNoisePub: serverKey.publicKey,
        kind: Kind.Session,
        payload: { v: 1, stream: "service", name: "goat" },
        localStatic: generateX25519(random),
        factory: fake.factory,
        clock,
        random,
      });
      const link = fake.socketFor(relay);
      link.open();
      await link.whenSent(1);
      const node = respond({
        kind: Kind.Session,
        nodeId: vector.responder.nodeId,
        localStatic: serverKey,
        message1: link.binarySent()[0] ?? new Uint8Array(),
        psk: () => undefined,
        random,
      });
      link.receive(node.message2);
      const stream = openStream((await pending).session);
      const socket = makePenWebSocketConstructor({
        origin: ORIGIN,
        openStream: async () => stream,
        clock,
        random,
      })("ws://goat.pen/ws");
      const closes: Array<number | undefined> = [];
      socket.addEventListener("close", (event) => closes.push(event.code));
      const opened = new Promise<void>((resolve) =>
        socket.addEventListener("open", () => resolve()),
      );
      // After message 1 come the key confirmation and the upgrade request as one DATA record.
      await link.whenSent(3);
      node.recv.open(link.binarySent()[1] ?? new Uint8Array());
      const request = latin1(node.recv.open(link.binarySent()[2] ?? new Uint8Array()).subarray(1));
      const key = /Sec-WebSocket-Key: ([^\r]+)/.exec(request)?.[1] ?? "";
      const head =
        "HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: " +
        websocketAccept(key) +
        "\r\n\r\n";
      link.receive(node.send.seal(Uint8Array.of(0, ...new TextEncoder().encode(head))));
      await opened;
      socket.send(new Uint8Array(STREAM_LIMITS.window + 64 * 1024));
      // The send now waits for credit: the window holds all but less than one record.
      while (stream.stats().inflight <= STREAM_LIMITS.window - STREAM_LIMITS.maxData)
        await link.whenSent(link.sent.length + 1);
      link.remoteClose(code);
      await stream.closed;
      await new Promise<void>((resolve) =>
        closes.length > 0 ? resolve() : socket.addEventListener("close", () => resolve()),
      );
      expect(closes).toEqual([code]);
    },
  );

  it("W27a, W27b, W27c: the handshake asks for version 13 with a 16-byte key and offers no extension", async () => {
    const c = await connected();
    expect(c.request.startsWith("GET /ws?x=1 HTTP/1.1\r\nHost: goat.pen\r\n")).toBe(true);
    expect(c.request).toContain("Sec-WebSocket-Version: 13\r\n");
    expect(fromBase64(c.key)).toHaveLength(16);
    expect(c.request).not.toMatch(/Sec-WebSocket-Extensions/i);
    expect(c.request).not.toMatch(/Sec-WebSocket-Protocol/i);
  });

  it("W27d: the handshake names the one requested subprotocol and accepts it back", async () => {
    const c = await connected({ protocol: "goat" });
    expect(c.request).toContain("Sec-WebSocket-Protocol: goat\r\n");
    c.accept("Sec-WebSocket-Protocol: goat\r\n");
    await c.opened;
    expect(c.socket.readyState).toBe(1);
  });

  it("W01, W02a: every outbound frame is masked with a fresh mask", async () => {
    const c = await connected();
    c.accept();
    await c.opened;
    c.socket.send("one");
    c.socket.send(Uint8Array.of(1, 2, 3));
    await c.whenFrames(2);
    const [first, second] = c.framesSent();
    expect(first).toMatchObject({ opcode: 1, masked: true, fin: true });
    expect(new TextDecoder().decode(first?.payload)).toBe("one");
    expect(second).toMatchObject({ opcode: 2, masked: true });
    expect(first?.mask).not.toBe(second?.mask);
  });

  it("W02b: a CSPRNG failure while sending sends nothing", async () => {
    let fail = false;
    let seed = 1;
    const c = await connected({
      random: (n) => {
        if (fail) throw new Error("no entropy");
        return new Uint8Array(n).fill(seed++);
      },
    });
    c.accept();
    await c.opened;
    const before = c.server.written().length;
    fail = true;
    expect(() => c.socket.send("x")).toThrow(
      expect.objectContaining({ code: "random-unavailable" }),
    );
    expect(c.server.written().length).toBe(before);
  });

  it("W24: a 101 and the first frame in one chunk deliver the open and then the message", async () => {
    const c = await connected();
    c.accept("", "\x81\x02hi");
    await c.whenEvent("message");
    expect(c.events.map((e) => e.type)).toEqual(["open", "message"]);
    expect(c.events[1]?.data).toBe("hi");
  });

  it("W20: a ping is answered with a pong carrying the same payload", async () => {
    const c = await connected();
    c.accept();
    await c.opened;
    c.server.write("\x89\x03abc");
    await c.whenFrames(1);
    expect(c.framesSent()[0]).toMatchObject({ opcode: 10 });
    expect(latin1(c.framesSent()[0]?.payload ?? new Uint8Array())).toBe("abc");
  });

  it("W22, W23: one message is handed out before the next chunk is read", async () => {
    const c = await connected();
    c.accept();
    await c.opened;
    c.server.write("\x82\x01\x01\x82\x01\x02");
    await c.whenEvent("message", 2);
    expect(
      c.events.filter((e) => e.type === "message").map((e) => [...(e.data as Uint8Array)]),
    ).toEqual([[1], [2]]);
  });

  it("a close from the server is echoed and reported with its code", async () => {
    const c = await connected();
    c.accept();
    await c.opened;
    c.server.write("\x88\x02\x0f\xa0");
    await c.whenEvent("close");
    expect(c.events.at(-1)).toMatchObject({ type: "close", code: 4000 });
    await c.whenFrames(1);
    expect(c.framesSent()[0]).toMatchObject({ opcode: 8 });
    expect(toHex(c.framesSent()[0]?.payload ?? new Uint8Array())).toBe("0fa0");
  });

  it("after close() no message is dispatched; the server's close still completes the closing", async () => {
    const c = await connected();
    c.accept();
    await c.opened;
    c.socket.close(1000);
    c.server.write("\x81\x01A\x88\x02\x03\xe8");
    await c.whenEvent("close");
    expect(c.events.map((e) => e.type)).toEqual(["open", "close"]);
    expect(c.events.at(-1)).toMatchObject({ code: 1000 });
  });

  it("a listener that throws is reported, and delivery and the close go on", async () => {
    const reported: Array<unknown> = [];
    vi.stubGlobal("reportError", (error: unknown) => reported.push(error));
    try {
      const c = await connected();
      for (const type of ["message", "error", "close"] as const) {
        c.socket.addEventListener(type, () => {
          throw new Error(type + " listener");
        });
      }
      c.accept();
      await c.opened;
      c.server.write("\x81\x01A\x81\x01B\xc1\x00");
      await c.whenEvent("close");
      expect(c.events.map((e) => e.type)).toEqual(["open", "message", "message", "error", "close"]);
      expect(c.events.at(-1)).toMatchObject({ code: 1002 });
      expect(reported.map((error) => (error as Error).message)).toEqual([
        "message listener",
        "message listener",
        "error listener",
        "close listener",
      ]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("the stream ending between frames closes the socket once with 1006", async () => {
    const c = await connected();
    c.accept();
    await c.opened;
    c.server.write("\x81\x02hi");
    c.server.end();
    await c.whenEvent("close");
    expect(c.events.map((e) => e.type)).toEqual(["open", "message", "error", "close"]);
    expect(c.events.at(-1)).toMatchObject({ code: 1006 });
  });

  it("a close whose frame cannot be written (no stream credit) still closes the stream when the 5 s close timeout fires", async () => {
    const c = await connected();
    c.accept();
    await c.opened;
    c.server.block();
    c.socket.close(1000, "bye");
    await c.clock.whenTimer(PEN_WEBSOCKET_LIMITS.closeMs);
    c.clock.advance(PEN_WEBSOCKET_LIMITS.closeMs);
    await c.whenEvent("close");
    expect(c.events.at(-1)).toMatchObject({ type: "close", code: 1006 });
    await c.server.whenClosed();
  });

  it("a failure with writes blocked still closes the stream once the 5 s drain limit passes", async () => {
    const c = await connected();
    c.accept();
    await c.opened;
    c.server.block();
    c.server.write("\xc1\x00");
    await c.whenEvent("close");
    expect(c.events.at(-1)).toMatchObject({ type: "close", code: 1002 });
    await c.clock.whenTimer(PEN_WEBSOCKET_LIMITS.closeMs);
    c.clock.advance(PEN_WEBSOCKET_LIMITS.closeMs);
    await c.server.whenClosed();
    expect(c.server.closeCode()).toBe(4408);
  });

  it.each([
    ["one read", ["\x81\x01A\xc1\x00"]],
    ["split after the first frame", ["\x81\x01A", "\xc1\x00"]],
  ])(
    "a good frame before a malformed one is delivered the same way in %s",
    async (_name, chunks) => {
      const c = await connected();
      c.accept();
      await c.opened;
      for (const chunk of chunks) c.server.write(chunk);
      await c.whenEvent("close");
      expect(c.events.map((e) => e.type)).toEqual(["open", "message", "error", "close"]);
      expect(c.events[1]?.data).toBe("A");
      expect(c.events.at(-1)).toMatchObject({ code: 1002 });
    },
  );

  it.each([
    ["an invalid code", () => [1005, ""] as const],
    ["a code that is not an integer", () => [Number.NaN, ""] as const],
    ["a reason over 123 bytes", () => [1000, "x".repeat(124)] as const],
  ])("close() with %s throws and leaves the socket open", async (_name, args) => {
    const c = await connected();
    c.accept();
    await c.opened;
    const [code, reason] = args();
    expect(() => c.socket.close(code, reason)).toThrow();
    expect(c.socket.readyState).toBe(1);
    c.socket.close(1000);
    expect(c.socket.readyState).toBe(2);
  });

  it("close() checks its arguments in every state, as the WebSocket standard does", async () => {
    const construct = makePenWebSocketConstructor({
      origin: ORIGIN,
      openStream: () => new Promise(() => undefined),
      clock: new ManualClock(),
      random: (n) => new Uint8Array(n),
    });
    const connecting = construct("ws://goat.pen/ws");
    expect(() => connecting.close(1005, "x")).toThrow();
    expect(() => connecting.close(1000, "x".repeat(124))).toThrow();
    expect(connecting.readyState).toBe(0);
    connecting.close(1000);
    expect(connecting.readyState).toBe(3);
    expect(() => connecting.close(Number.NaN)).toThrow();
  });

  it("close() when the CSPRNG fails throws and leaves the socket open", async () => {
    let fail = false;
    let seed = 1;
    const c = await connected({
      random: (n) => {
        if (fail) throw new Error("no entropy");
        return new Uint8Array(n).fill(seed++);
      },
    });
    c.accept();
    await c.opened;
    fail = true;
    expect(() => c.socket.close(1000)).toThrow(
      expect.objectContaining({ code: "random-unavailable" }),
    );
    expect(c.socket.readyState).toBe(1);
  });

  it("a malformed server frame fails the socket with the rule's close code", async () => {
    const c = await connected();
    c.accept();
    await c.opened;
    c.server.write("\xc1\x00");
    await c.whenEvent("close");
    expect(c.events.at(-1)).toMatchObject({ type: "close", code: 1002 });
  });

  it("a refused upgrade (an extension in the 101) never opens and reports 1006", async () => {
    const c = await connected();
    c.accept("Sec-WebSocket-Extensions: permessage-deflate\r\n");
    await c.whenEvent("close");
    expect(c.events.map((e) => e.type)).toEqual(["error", "close"]);
    expect(c.socket.readyState).toBe(3);
  });

  it("send before open throws as React Native's WebSocket does; an options object is refused", async () => {
    const c = await connected();
    expect(() => c.socket.send("x")).toThrow("INVALID_STATE_ERR");
    const construct = makePenWebSocketConstructor({
      origin: ORIGIN,
      openStream: async () => memoryStreamPair().client,
      clock: new ManualClock(),
      random: (n) => new Uint8Array(n),
    });
    expect(() => construct("ws://goat.pen/ws", { headers: {} })).toThrow(TypeError);
    expect(() => construct("ws://other.pen/ws")).toThrow(
      expect.objectContaining({ code: "http1/H47" }),
    );
  });

  it("an outbound buffer past 1,024 frames fails the socket and sends close 1008 when it can", async () => {
    const c = await connected();
    c.accept();
    await c.opened;
    const sockets: Array<PenWebSocketLike> = [c.socket];
    for (let i = 0; i <= PEN_WEBSOCKET_LIMITS.outboundFrames + 1 && c.socket.readyState === 1; i++)
      sockets[0]?.send("x");
    await c.whenEvent("close");
    expect(c.events.at(-1)).toMatchObject({ type: "close", code: 1006 });
  });

  it("an overflow whose close frame cannot be masked (CSPRNG failure) still ends the socket", async () => {
    const run = async (failAt?: number) => {
      let calls = 0;
      const c = await connected({
        random: (n) => {
          calls += 1;
          if (calls === failAt) throw new Error("no entropy");
          return new Uint8Array(n).fill(calls & 255);
        },
      });
      c.accept();
      await c.opened;
      for (
        let i = 0;
        i <= PEN_WEBSOCKET_LIMITS.outboundFrames + 1 && c.socket.readyState === 1;
        i++
      )
        c.socket.send("x");
      await c.whenEvent("close");
      return { calls, socket: c.socket, last: c.events.at(-1) };
    };
    // The close frame's mask is the last random draw of a run that can draw it.
    const dry = await run();
    const failing = await run(dry.calls);
    expect(failing.socket.readyState).toBe(3);
    expect(failing.last).toMatchObject({ type: "close", code: 1006 });
  });
});

function fromBase64(text: string): Uint8Array {
  return fromHex(
    [...atob(text)].map((ch) => ch.charCodeAt(0).toString(16).padStart(2, "0")).join(""),
  );
}
