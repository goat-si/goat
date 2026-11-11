import { describe, expect, it, vi } from "vite-plus/test";
import { parseAck } from "../wire.ts";
import { dialRelay, RELAY_LIMITS } from "./relayClient.ts";
import { fakeFactory } from "./testing/fakeRelay.ts";
import { ManualClock } from "./testing/manualClock.ts";

const NODE = "cc5gqlek2e2rhfy6rnliqgvlrm";
const RELAY = "wss://pen-relay.pos090001.workers.dev";
const KiB = 1024;
const MiB = 1024 * KiB;

async function opened(options: { extensions?: string } = {}) {
  const clock = new ManualClock();
  const fake = fakeFactory();
  const dial = dialRelay({ relay: RELAY, nodeId: NODE, factory: fake.factory, clock });
  const socket = fake.socketFor(RELAY);
  if (options.extensions !== undefined) socket.extensions = options.extensions;
  socket.open();
  return { clock, socket, link: await dial.opened };
}

describe("relay client socket (CONTRACT Relay, design 10.1)", () => {
  it("dials /v1/client/<nodeId> on the relay origin, binary, with no subprotocol argument", async () => {
    const { socket } = await opened();
    expect(socket.url).toBe(RELAY + "/v1/client/" + NODE);
    expect(socket.binaryType).toBe("arraybuffer");
  });

  it("refuses a relay that is not wss (ws only for loopback) and a malformed node id", () => {
    const fake = fakeFactory();
    const clock = new ManualClock();
    expect(() =>
      dialRelay({ relay: "ws://relay.example", nodeId: NODE, factory: fake.factory, clock }),
    ).toThrow(expect.objectContaining({ code: "relay-url" }));
    expect(() =>
      dialRelay({ relay: RELAY, nodeId: "NOT-A-NODE", factory: fake.factory, clock }),
    ).toThrow(expect.objectContaining({ code: "node-id" }));
    expect(fake.sockets).toHaveLength(0);
  });

  it("a socket that negotiated an extension (permessage-deflate) is closed 4402 and the dial fails", async () => {
    await expect(opened({ extensions: "permessage-deflate" })).rejects.toMatchObject({
      code: "relay-extension",
    });
  });

  it("acks a:<n> exactly when 64 KiB has arrived since the last ack, counting every binary byte on arrival", async () => {
    const { socket, link } = await opened();
    link.attach(() => undefined);
    for (const size of [40 * KiB, 30 * KiB, 60 * KiB, 5 * KiB])
      socket.receive(new Uint8Array(size));
    expect(socket.textSent()).toEqual(["a:" + 70 * KiB, "a:" + 135 * KiB]);
    expect(socket.textSent().map((text) => parseAck(text))).toEqual([70 * KiB, 135 * KiB]);
  });

  it("a link closed before attach still hands over what came first, but a close asked for during that drain stops it", async () => {
    const { socket, link } = await opened();
    socket.receive(Uint8Array.of(1));
    socket.receive(Uint8Array.of(2));
    socket.remoteClose(1000);
    const seen: Array<number> = [];
    link.attach((message) => {
      seen.push(message[0] ?? -1);
      link.close(4400);
    });
    expect(seen).toEqual([1]);
  });

  it.each([
    "close(4400)",
    "an error event",
    "a refused send",
    "close(4400) during a drain",
  ] as const)(
    "a socket that reports its close synchronously from close() does not replace the code: %s",
    async (how) => {
      const { socket, link } = await opened();
      const close = socket.close.bind(socket);
      socket.close = (code) => {
        close(code);
        socket.remoteClose(1005);
      };
      const notices: Array<number> = [];
      if (how === "close(4400) during a drain") {
        socket.receive(Uint8Array.of(1));
        link.attach(
          () => link.close(4400),
          (code) => notices.push(code),
        );
      } else {
        link.attach(
          () => undefined,
          (code) => notices.push(code),
        );
        if (how === "close(4400)") link.close(4400);
        if (how === "an error event") socket.fail();
        if (how === "a refused send") {
          socket.send = () => {
            throw new Error("socket gone");
          };
          expect(() => link.send(Uint8Array.of(1))).toThrow("socket gone");
        }
      }
      const expected = how.startsWith("close(4400)") ? 4400 : 1006;
      expect(await link.closed).toBe(expected);
      expect(notices).toEqual([expected]);
    },
  );

  it("an observer attached from inside the socket's close() hears of the close once", async () => {
    const { socket, link } = await opened();
    socket.receive(Uint8Array.of(1));
    const seen: Array<string> = [];
    const close = socket.close.bind(socket);
    socket.close = (code) => {
      close(code);
      link.attach(
        (message) => seen.push("data:" + message[0]),
        (closeCode) => seen.push("close:" + closeCode),
      );
    };
    link.close(4400);
    expect(seen).toEqual(["data:1", "close:4400"]);
  });

  it("a link takes one receiver: a second attach, reentrant or later, is refused", async () => {
    const later = await opened();
    later.link.attach(() => undefined);
    later.link.close(1000);
    expect(() => later.link.attach(() => undefined)).toThrow(
      expect.objectContaining({ code: "relay-attached" }),
    );

    const reentrant = await opened();
    reentrant.socket.receive(Uint8Array.of(1));
    let refused: unknown;
    reentrant.link.attach(() => {
      try {
        reentrant.link.attach(() => undefined);
      } catch (error) {
        refused = error;
      }
    });
    expect(refused).toMatchObject({ code: "relay-attached" });
  });

  it("a link this side closed before attach still hands over what arrived first", async () => {
    const { socket, link } = await opened();
    socket.receive(Uint8Array.of(1));
    socket.receive(Uint8Array.of(2));
    link.close(1000);
    const seen: Array<number> = [];
    link.attach((message) => seen.push(message[0] ?? -1));
    expect(seen).toEqual([1, 2]);
  });

  it("a peer close during the held drain waits for it: every earlier message, then one close notice", async () => {
    const { socket, link } = await opened();
    socket.receive(Uint8Array.of(1));
    socket.receive(Uint8Array.of(2));
    const seen: Array<string> = [];
    link.attach(
      (message) => {
        seen.push("data:" + message[0]);
        if (message[0] === 1) socket.remoteClose(1000);
      },
      (code) => seen.push("close:" + code),
    );
    expect(seen).toEqual(["data:1", "data:2", "close:1000"]);
  });

  it.each(["held", "live"] as const)(
    "a receiver that throws on a %s message is reported, closes the link 1011 and gets nothing more",
    async (when) => {
      const reported: Array<unknown> = [];
      vi.stubGlobal("reportError", (error: unknown) => reported.push(error));
      try {
        const { socket, link } = await opened();
        let calls = 0;
        const receiver = () => {
          calls += 1;
          throw new Error("receiver failure");
        };
        if (when === "held") {
          socket.receive(Uint8Array.of(1));
          socket.receive(Uint8Array.of(2));
          link.attach(receiver);
        } else {
          link.attach(receiver);
          expect(() => socket.receive(Uint8Array.of(1))).not.toThrow();
          socket.receive(Uint8Array.of(2));
        }
        expect(calls).toBe(1);
        expect(socket.closedWith).toBe(1011);
        expect(reported).toHaveLength(1);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it("a receiver that closes the link while held messages drain gets no more and one close notice", async () => {
    const { socket, link } = await opened();
    socket.receive(Uint8Array.of(1));
    socket.receive(Uint8Array.of(2));
    const seen: Array<number> = [];
    let closes = 0;
    link.attach(
      (message) => {
        seen.push(message[0] ?? -1);
        link.close(1000);
      },
      () => {
        closes += 1;
      },
    );
    expect(seen).toEqual([1]);
    expect(closes).toBe(1);
  });

  it("sends a text ping every 30 s while open and none after close", async () => {
    const { clock, socket, link } = await opened();
    clock.advance(29_999);
    expect(socket.textSent()).toEqual([]);
    clock.advance(1);
    clock.advance(30_000);
    expect(socket.textSent()).toEqual(["ping", "ping"]);
    link.close(1000);
    clock.advance(90_000);
    expect(socket.textSent()).toEqual(["ping", "ping"]);
  });

  it("a ping or an ack the socket refuses to send closes the link 1006 and wakes its waiters", async () => {
    const pinged = await opened();
    pinged.socket.send = () => {
      throw new Error("socket gone");
    };
    const waiting = pinged.link.receive();
    pinged.clock.advance(RELAY_LIMITS.pingMs);
    await expect(waiting).rejects.toMatchObject({ code: "relay-closed", closeCode: 1006 });
    expect(await pinged.link.closed).toBe(1006);

    const acked = await opened();
    const delivered: Array<number> = [];
    acked.link.attach((message) => delivered.push(message.length));
    acked.socket.send = () => {
      throw new Error("socket gone");
    };
    acked.socket.receive(new Uint8Array(RELAY_LIMITS.ackEvery));
    expect(await acked.link.closed).toBe(1006);
    expect(delivered).toEqual([]);
  });

  it("an error event ends the link 1006: a dial still connecting fails, an open link wakes its waiters", async () => {
    const fake = fakeFactory();
    const dial = dialRelay({
      relay: RELAY,
      nodeId: NODE,
      factory: fake.factory,
      clock: new ManualClock(),
    });
    fake.socketFor(RELAY).fail();
    await expect(dial.opened).rejects.toMatchObject({ code: "relay-closed", closeCode: 1006 });

    const open = await opened();
    const waiting = open.link.receive();
    open.socket.fail();
    await expect(waiting).rejects.toMatchObject({ code: "relay-closed", closeCode: 1006 });
    expect(await open.link.closed).toBe(1006);
    // A socket that reported an error but did not close itself is closed (with no code).
    expect(open.socket.closedWith).toBeNull();
  });

  it("a binary send the socket refuses ends the link 1006; close() finishes even when the socket's close throws", async () => {
    const refused = await opened();
    refused.socket.send = () => {
      throw new Error("socket gone");
    };
    expect(() => refused.link.send(Uint8Array.of(1))).toThrow("socket gone");
    expect(await refused.link.closed).toBe(1006);

    const stuck = await opened();
    stuck.socket.close = () => {
      throw new Error("cannot close");
    };
    stuck.link.close(1000);
    expect(await stuck.link.closed).toBe(1000);
  });

  it("closes 1003 on any text other than pong and 1009 on a binary message over 1 MiB (CONTRACT Relay text, 1 MiB cap)", async () => {
    const first = await opened();
    first.socket.receive("pong");
    expect(first.socket.closedWith).toBeUndefined();
    first.socket.receive("hello");
    expect(first.socket.closedWith).toBe(1003);
    expect(await first.link.closed).toBe(1003);

    const second = await opened();
    second.link.attach(() => undefined);
    second.socket.receive(new Uint8Array(RELAY_LIMITS.message));
    expect(second.socket.closedWith).toBeUndefined();
    second.socket.receive(new Uint8Array(RELAY_LIMITS.message + 1));
    expect(second.socket.closedWith).toBe(1009);
  });

  it("holds at most 64 messages and 1 MiB before a receiver attaches; past either it closes 4408", async () => {
    const count = await opened();
    for (let i = 0; i < 64; i++) count.socket.receive(new Uint8Array(1));
    expect(count.socket.closedWith).toBeUndefined();
    count.socket.receive(new Uint8Array(1));
    expect(count.socket.closedWith).toBe(4408);

    const bytes = await opened();
    bytes.socket.receive(new Uint8Array(MiB - 10));
    bytes.socket.receive(new Uint8Array(11));
    expect(bytes.socket.closedWith).toBe(4408);
  });

  it("delivers held messages in order to the receiver, then every later one synchronously", async () => {
    const { socket, link } = await opened();
    socket.receive(Uint8Array.of(1));
    expect(await link.receive()).toEqual(Uint8Array.of(1));
    socket.receive(Uint8Array.of(2));
    const seen: Array<number> = [];
    link.attach((message) => seen.push(message[0] ?? -1));
    socket.receive(Uint8Array.of(3));
    expect(seen).toEqual([2, 3]);
  });

  it("while 1 MiB or more is buffered, writable() waits and acks still go out; it resumes on the 25 ms recheck", async () => {
    const { clock, socket, link } = await opened();
    link.attach(() => undefined);
    socket.bufferedAmount = MiB;
    let resumed = false;
    const writable = link.writable().then(() => {
      resumed = true;
    });
    socket.receive(new Uint8Array(64 * KiB));
    expect(socket.textSent()).toEqual(["a:" + 64 * KiB]);
    socket.bufferedAmount = MiB - 1;
    clock.advance(24);
    await Promise.resolve();
    expect(resumed).toBe(false);
    clock.advance(1);
    await writable;
    expect(resumed).toBe(true);
  });

  it("closes 4408 when more than 4 MiB is buffered, when 1 MiB stays buffered for 30 s, or when bufferedAmount is not a number", async () => {
    const over = await opened();
    over.socket.bufferedAmount = 4 * MiB + 1;
    over.link.send(new Uint8Array(1));
    expect(over.socket.closedWith).toBe(4408);

    const stalled = await opened();
    stalled.socket.bufferedAmount = MiB;
    stalled.link.send(new Uint8Array(1));
    stalled.clock.advance(29_999);
    expect(stalled.socket.closedWith).toBeUndefined();
    stalled.clock.advance(1);
    expect(stalled.socket.closedWith).toBe(4408);

    const unknown = await opened();
    Object.defineProperty(unknown.socket, "bufferedAmount", { value: undefined });
    expect(() => unknown.link.send(new Uint8Array(1))).toThrow(
      expect.objectContaining({ code: "relay-buffer" }),
    );
    expect(unknown.socket.closedWith).toBe(4408);
  });

  it("reports the socket's close code, and 1006 when the close carries none", async () => {
    const coded = await opened();
    coded.socket.remoteClose(4404);
    expect(await coded.link.closed).toBe(4404);
    await expect(coded.link.receive()).rejects.toMatchObject({
      code: "relay-closed",
      closeCode: 4404,
    });
    const bare = await opened();
    bare.socket.remoteClose(undefined as unknown as number);
    expect(await bare.link.closed).toBe(1006);
  });

  it("an outbound message over 1 MiB is refused before it reaches the socket", async () => {
    const { socket, link } = await opened();
    expect(() => link.send(new Uint8Array(RELAY_LIMITS.message + 1))).toThrow(
      expect.objectContaining({ code: "message-too-large" }),
    );
    expect(socket.binarySent()).toHaveLength(0);
  });
});
