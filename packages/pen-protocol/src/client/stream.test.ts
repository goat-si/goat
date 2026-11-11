import { describe, expect, it } from "vite-plus/test";
import vector from "../../vectors/session.json" with { type: "json" };
import { fromHex } from "./bytes.ts";
import { generateX25519, x25519PublicKey } from "./crypto.ts";
import { Kind } from "./noise.ts";
import { openSession } from "./race.ts";
import { openStream, STREAM_LIMITS } from "./stream.ts";
import { fakeFactory } from "./testing/fakeRelay.ts";
import { ManualClock } from "./testing/manualClock.ts";
import { respond } from "./testing/noiseResponder.ts";

const NODE = vector.responder.nodeId;
const RELAY = "wss://relay-a.example";
const KiB = 1024;
const serverPriv = fromHex(vector.responder.noisePriv);
const serverKey = { privateKey: serverPriv, publicKey: x25519PublicKey(serverPriv) };
let seed = 1;
const random = (n: number) => new Uint8Array(n).fill(seed++ & 255);

const u32le = (n: number) => {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, n, true);
  return out;
};
const record = (type: number, body: Uint8Array = new Uint8Array(0)) => Uint8Array.of(type, ...body);
const data = (bytes: Uint8Array) => {
  const out = new Uint8Array(bytes.length + 1);
  out.set(bytes, 1);
  return out;
};

/** A stream over a real Noise session; the test plays the Pen node on the other side. */
async function connected() {
  const clock = new ManualClock();
  const fake = fakeFactory();
  const pending = openSession({
    relays: [RELAY],
    nodeId: NODE,
    serverNoisePub: serverKey.publicKey,
    kind: Kind.Session,
    payload: { v: 1, stream: "service", name: "goat" },
    localStatic: generateX25519(random),
    factory: fake.factory,
    clock,
    random,
  });
  const socket = fake.socketFor(RELAY);
  socket.open();
  await socket.whenSent(1);
  const reply = respond({
    kind: Kind.Session,
    nodeId: NODE,
    localStatic: serverKey,
    message1: socket.binarySent()[0] ?? new Uint8Array(),
    psk: () => undefined,
    random,
  });
  socket.receive(reply.message2);
  const { session } = await pending;
  const stream = openStream(session);
  let read = 2; // message 1 and the key confirmation
  reply.recv.open(socket.binarySent()[1] ?? new Uint8Array());
  return {
    clock,
    socket,
    stream,
    /** The node sends one stream record. */
    send: (plaintext: Uint8Array) => socket.receive(reply.send.seal(plaintext)),
    /** Records the client sent since the last call, decrypted. */
    received: () => {
      const out = socket
        .binarySent()
        .slice(read)
        .map((sealed) => reply.recv.open(sealed));
      read = socket.binarySent().length;
      return out;
    },
  };
}

describe("Pen stream framing (CONTRACT Streams: DATA, FIN, CREDIT)", () => {
  it.each([
    ["65,518-byte records", [65_518]],
    ["1-byte and 65,518-byte records", [1, 65_518]],
    ["alternating 1-byte, 4 KiB and 65,518-byte records", [1, 4 * KiB, 65_518]],
  ])(
    "accepts the whole 512 KiB window in %s and never buffers more than 512 KiB",
    async (_name, sizes) => {
      const c = await connected();
      let sent = 0;
      for (let i = 0; sent < STREAM_LIMITS.window; i++) {
        const size = Math.min(sizes[i % sizes.length] ?? 1, STREAM_LIMITS.window - sent);
        c.send(data(new Uint8Array(size).fill(i & 255)));
        sent += size;
        expect(c.stream.stats().buffered).toBeLessThanOrEqual(STREAM_LIMITS.window);
      }
      expect(c.socket.closedWith).toBeUndefined();
      expect(c.stream.stats().capacity).toBe(STREAM_LIMITS.window);
      c.send(data(new Uint8Array(1)));
      expect(c.socket.closedWith).toBe(4408);
    },
  );

  it("partial reads between arrivals keep the ring within its capacity and return every byte in order", async () => {
    const c = await connected();
    const expected: Array<number> = [];
    let got: Array<number> = [];
    for (let i = 0; i < 40; i++) {
      const bytes = new Uint8Array(i % 3 === 0 ? 1 : i % 3 === 1 ? 4 * KiB : 30_000).fill(i);
      expected.push(...bytes);
      c.send(data(bytes));
      if (i % 4 === 3) got = got.concat([...((await c.stream.read()) ?? [])]);
    }
    c.send(record(1));
    for (;;) {
      const chunk = await c.stream.read();
      if (chunk === null) break;
      got = got.concat([...chunk]);
    }
    expect(got).toEqual(expected);
  });

  it("CREDIT goes out once 64 KiB has been read, not before, and for the remainder after the node's FIN", async () => {
    const c = await connected();
    c.send(data(new Uint8Array(40 * KiB)));
    expect((await c.stream.read())?.length).toBe(40 * KiB);
    expect(c.received()).toEqual([]);
    c.send(data(new Uint8Array(40 * KiB)));
    expect((await c.stream.read())?.length).toBe(40 * KiB);
    expect(c.received()).toEqual([record(2, u32le(80 * KiB))]);
    c.send(data(new Uint8Array(10)));
    c.send(record(1));
    expect((await c.stream.read())?.length).toBe(10);
    expect(await c.stream.read()).toBeNull();
    expect(c.received()).toEqual([record(2, u32le(10))]);
  });

  it("a writer waits at the 512 KiB window and resumes when CREDIT arrives", async () => {
    const c = await connected();
    await c.stream.write(new Uint8Array(512 * KiB));
    const sentData = c.received();
    expect(sentData.reduce((sum, r) => sum + r.length - 1, 0)).toBe(512 * KiB);
    expect(sentData.every((r) => r.length - 1 <= STREAM_LIMITS.maxData)).toBe(true);
    let done = false;
    const next = c.stream.write(new Uint8Array(1)).then(() => (done = true));
    await Promise.resolve();
    expect(done).toBe(false);
    expect(c.received()).toEqual([]);
    c.send(record(2, u32le(64 * KiB)));
    await next;
    expect(c.received()).toEqual([data(new Uint8Array(1))]);
  });

  it("end() during a write blocked at the window sends FIN only after that write's DATA", async () => {
    const c = await connected();
    await c.stream.write(new Uint8Array(512 * KiB));
    c.received();
    const blocked = c.stream.write(Uint8Array.of(9));
    c.stream.end();
    expect(c.received()).toEqual([]);
    c.send(record(2, u32le(64 * KiB)));
    await blocked;
    expect(c.received()).toEqual([data(Uint8Array.of(9)), record(1)]);
  });

  it("refuses a second write while one is pending and a single write over 1 MiB", async () => {
    const c = await connected();
    await expect(c.stream.write(new Uint8Array(STREAM_LIMITS.maxWrite + 1))).rejects.toMatchObject({
      code: "write-too-large",
    });
    void c.stream.write(new Uint8Array(600 * KiB));
    await expect(c.stream.write(new Uint8Array(1))).rejects.toMatchObject({
      code: "write-pending",
    });
  });

  it.each([
    ["an empty record", new Uint8Array(0)],
    ["a FIN with extra bytes", Uint8Array.of(1, 0)],
    ["a CREDIT that is not 5 bytes", Uint8Array.of(2, 0, 0)],
    ["a CREDIT above what is in flight", record(2, u32le(1))],
    ["an unknown record type", Uint8Array.of(9)],
  ])("closes 4400 on %s", async (_name, bad) => {
    const c = await connected();
    c.send(bad);
    expect(c.socket.closedWith).toBe(4400);
    await expect(c.stream.read()).rejects.toMatchObject({ code: "stream-closed", closeCode: 4400 });
  });

  it("closes 4400 on DATA after the node's FIN and on a second FIN", async () => {
    const first = await connected();
    first.send(record(1));
    first.send(data(Uint8Array.of(1)));
    expect(first.socket.closedWith).toBe(4400);
    const second = await connected();
    second.send(record(1));
    second.send(record(1));
    expect(second.socket.closedWith).toBe(4400);
  });

  it("DATA, DATA and FIN arriving before any read are all read, then end of stream, then close 1000 after our FIN", async () => {
    const c = await connected();
    c.send(data(Uint8Array.of(1, 2)));
    c.send(data(Uint8Array.of(3)));
    c.send(record(1));
    c.stream.end();
    expect(c.socket.closedWith).toBeUndefined();
    expect(await c.stream.read()).toEqual(Uint8Array.of(1, 2, 3));
    expect(await c.stream.read()).toBeNull();
    expect(c.received()).toEqual([record(1), record(2, u32le(3))]);
    expect(c.socket.closedWith).toBe(1000);
    expect(await c.stream.closed).toBe(1000);
  });

  it("data that arrived before the node's FIN stays readable after the session closes normally", async () => {
    const c = await connected();
    c.send(data(Uint8Array.of(7)));
    c.send(record(1));
    c.socket.remoteClose(1000);
    expect(await c.stream.read()).toEqual(Uint8Array.of(7));
    expect(await c.stream.read()).toBeNull();
  });

  it("a session that closes before FIN fails reads after the buffered bytes", async () => {
    const c = await connected();
    c.send(data(Uint8Array.of(7)));
    c.socket.remoteClose(4404);
    expect(await c.stream.read()).toEqual(Uint8Array.of(7));
    await expect(c.stream.read()).rejects.toMatchObject({ code: "stream-closed", closeCode: 4404 });
  });
});
