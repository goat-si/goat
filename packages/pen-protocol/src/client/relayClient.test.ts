import { describe, expect, it } from "vite-plus/test";
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
