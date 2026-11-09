// @effect-diagnostics globalFetch:off - The relay is a plain Worker; tests call it over HTTP.
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { CloseCode, type Frame, FrameType, Limits, readClose } from "@goat/pen-protocol/wire";
import {
  type Client,
  client,
  type FakeNode,
  fakeNode,
  type FakeNodeOptions,
  randomSeed,
  type Relay,
  startRelay,
} from "./harness.ts";

const bytes = (text: string) => new TextEncoder().encode(text);
const text = (data: Uint8Array) => new TextDecoder().decode(data);

async function readyNode(relay: Relay, options?: FakeNodeOptions): Promise<FakeNode> {
  const node = await fakeNode(relay.url, randomSeed(), options);
  await node.ready();
  return node;
}

async function session(
  relay: Relay,
  node: FakeNode,
  options?: { ack?: boolean },
): Promise<{ c: Client; sid: number }> {
  const c = client(relay.url, node.nodeId, options);
  const open = await node.expect(FrameType.Open);
  return { c, sid: open.sid };
}

/** A session the node has answered, so it counts as active. */
async function activeSession(relay: Relay, node: FakeNode, options?: { ack?: boolean }) {
  const opened = await session(relay, node, options);
  node.send(FrameType.Data, opened.sid, bytes("hi"));
  expect(text(await opened.c.messages.next())).toBe("hi");
  return opened;
}

/** Skips this session's DATA frames until its CLOSE and returns the code. */
async function closeOf(node: FakeNode, sid: number): Promise<number | null> {
  let frame: Frame = await node.frames.next();
  while (!(frame.type === FrameType.Close && frame.sid === sid)) {
    if (frame.type !== FrameType.Data || frame.sid !== sid)
      throw new Error(`unexpected frame ${frame.type}/${frame.sid}`);
    frame = await node.frames.next();
  }
  return readClose(frame.payload);
}

describe("pen relay contract (default limits)", () => {
  let relay: Relay;
  beforeAll(async () => {
    relay = await startRelay();
  });
  afterAll(async () => {
    await relay?.stop();
  });

  it("GET /healthz answers the protocol version; bad node ids are 400, non-upgrades 426, other paths 404", async () => {
    const health = await fetch(`${relay.url}/healthz`);
    expect(await health.json()).toEqual({ ok: true, version: "pen-relay/1.0" });
    const nodeId = (await fakeNode(relay.url, randomSeed(), { silent: true })).nodeId;
    expect((await fetch(`${relay.url}/v1/node/${nodeId.toUpperCase()}`)).status).toBe(400);
    expect((await fetch(`${relay.url}/v1/client/${nodeId}1`)).status).toBe(400);
    expect((await fetch(`${relay.url}/v1/node/${nodeId}`)).status).toBe(426);
    expect((await fetch(`${relay.url}/v1/client/${nodeId}`)).status).toBe(426);
    expect((await fetch(`${relay.url}/v2/node/${nodeId}`)).status).toBe(404);
  });

  it("an authenticated uplink gets OPEN per client and DATA both ways; a client close reaches the node as CLOSE with its code", async () => {
    const node = await readyNode(relay);
    const first = await session(relay, node);
    const second = await session(relay, node);
    expect(second.sid).toBeGreaterThan(first.sid);
    await first.c.send(bytes("hello"));
    expect(text((await node.expect(FrameType.Data, first.sid)).payload)).toBe("hello");
    node.send(FrameType.Data, second.sid, bytes("world"));
    expect(text(await second.c.messages.next())).toBe("world");
    first.c.close(4000);
    expect(readClose((await node.expect(FrameType.Close, first.sid)).payload)).toBe(4000);
    node.send(FrameType.Close, second.sid, Uint8Array.of(0x01, 0x10));
    expect(await second.c.closed).toBe(4097);
  });

  it("a client close code outside 1000..4999 reaches the node as CLOSE 1000", async () => {
    const node = await readyNode(relay);
    for (const code of [999, 5000]) {
      const { c, sid } = await session(relay, node);
      await c.opened;
      c.close(code);
      expect(readClose((await node.expect(FrameType.Close, sid)).payload)).toBe(1000);
    }
  });

  it("a wrong signature, a signPub whose nodeId is not the path's, and a wrong-length answer close the uplink 4403", async () => {
    const other = await fakeNode(relay.url, randomSeed(), { silent: true });
    const refused = await Promise.all([
      fakeNode(relay.url, randomSeed(), {
        answer: ({ signPub, signature }) =>
          new Uint8Array([...signPub, ...signature.map((byte, i) => (i === 0 ? byte ^ 1 : byte))]),
      }),
      fakeNode(relay.url, randomSeed(), { pathNodeId: other.nodeId }),
      fakeNode(relay.url, randomSeed(), {
        answer: ({ signPub, signature }) => new Uint8Array([...signPub, ...signature]).slice(0, 95),
      }),
    ]);
    expect(await Promise.all(refused.map((node) => node.closed))).toEqual([4403, 4403, 4403]);
    other.close(1000);
  });

  it("a client for a node with no authenticated uplink closes 4404", async () => {
    const silent = await fakeNode(relay.url, randomSeed(), { silent: true });
    expect(await client(relay.url, silent.nodeId).closed).toBe(CloseCode.Offline);
    silent.close(1000);
  });

  it("a newer authenticated uplink replaces the old one with 4409, closes its sessions 4404, and never reuses a sid", async () => {
    const seed = randomSeed();
    const old = await fakeNode(relay.url, seed);
    await old.ready();
    const { c } = await activeSession(relay, old);
    const replacement = await fakeNode(relay.url, seed);
    expect(await old.closed).toBe(CloseCode.Replaced);
    expect(await c.closed).toBe(CloseCode.Offline);
    await replacement.ready();
    const seen = [...old.openedSids, ...replacement.openedSids];
    const next = await session(relay, replacement);
    expect(next.sid).toBeGreaterThan(Math.max(...seen));
  });

  it("a ninth pending session closes the oldest pending one 4429", async () => {
    const node = await readyNode(relay);
    const pending: Array<{ c: Client; sid: number }> = [];
    for (let i = 0; i < Limits.PENDING_MAX; i++) pending.push(await session(relay, node));
    const ninth = client(relay.url, node.nodeId);
    const oldest = pending[0];
    expect(readClose((await node.expect(FrameType.Close, oldest?.sid)).payload)).toBe(
      CloseCode.Caps,
    );
    await node.expect(FrameType.Open);
    expect(await oldest?.c.closed).toBe(CloseCode.Caps);
    ninth.close(1000);
  });

  it("a pending session whose first node DATA would make a 33rd active one closes 4429", async () => {
    const node = await readyNode(relay);
    for (let i = 0; i < Limits.ACTIVE_MAX; i++) await activeSession(relay, node);
    const extra = await session(relay, node);
    node.send(FrameType.Data, extra.sid, bytes("one too many"));
    expect(readClose((await node.expect(FrameType.Close, extra.sid)).payload)).toBe(CloseCode.Caps);
    expect(await extra.c.closed).toBe(CloseCode.Caps);
  });

  it("a heavy session past its fair share of the uplink window ends alone with 4408 while a light session keeps flowing", async () => {
    const node = await readyNode(relay, { ack: false });
    const heavy = await activeSession(relay, node);
    const light = await activeSession(relay, node);
    const chunk = new Uint8Array(64 * 1024);
    for (let i = 0; i < 70; i++) await heavy.c.send(chunk);
    expect(await closeOf(node, heavy.sid)).toBe(CloseCode.Timeout);
    expect(await heavy.c.closed).toBe(CloseCode.Timeout);
    // The heavy session may fill the window only to 4 MiB minus 16 KiB for the other session.
    expect(node.received()).toBeLessThanOrEqual(Limits.SOCKET_WINDOW - Limits.LIGHT_SESSION + 7);
    await light.c.send(bytes("still here"));
    expect(text((await node.expect(FrameType.Data, light.sid)).payload)).toBe("still here");
  });

  it("relay frames may use 64 KiB past the uplink window; an uplink that leaves even that unacked closes 4408", async () => {
    const node = await readyNode(relay, { ack: false });
    const heavy = await activeSession(relay, node);
    await activeSession(relay, node);
    const chunk = new Uint8Array(64 * 1024);
    for (let i = 0; i < 70; i++) await heavy.c.send(chunk);
    expect(await closeOf(node, heavy.sid)).toBe(CloseCode.Timeout);
    // Light sessions fill the rest of the window with DATA.
    for (
      let gap = Limits.SOCKET_WINDOW - node.received();
      gap > Limits.FRAME_HEADER * 2;
      gap = Limits.SOCKET_WINDOW - node.received()
    ) {
      const filler = await session(relay, node);
      const size =
        Math.min(Limits.LIGHT_SESSION, Limits.SOCKET_WINDOW - node.received()) -
        Limits.FRAME_HEADER;
      await filler.c.send(new Uint8Array(size));
      await node.expect(FrameType.Data, filler.sid);
    }
    expect(node.received()).toBeGreaterThan(Limits.SOCKET_WINDOW - Limits.FRAME_HEADER * 2);
    // Each new client now costs an OPEN and evicts the oldest pending one with a CLOSE.
    let outcome: number | "open" = "open";
    while (outcome === "open") {
      const batch = 100;
      for (let i = 0; i < batch; i++) client(relay.url, node.nodeId);
      const opens = (async () => {
        let seen = 0;
        while (seen < batch) if ((await node.frames.next()).type === FrameType.Open) seen++;
        return "open" as const;
      })();
      outcome = await Promise.race([opens, node.closed]);
    }
    expect(outcome).toBe(CloseCode.Timeout);
    expect(node.received()).toBeGreaterThan(Limits.SOCKET_WINDOW + Limits.RELAY_HEADROOM - 12);
    expect(node.received()).toBeLessThanOrEqual(Limits.SOCKET_WINDOW + Limits.RELAY_HEADROOM);
  });

  it("frame types other than DATA and CLOSE from the node, reserved 4-7 included, close the uplink 4402 and its sessions 4404", async () => {
    const cases = await Promise.all(
      [FrameType.Open, 4, 5, 6, 7, 9].map(async (type) => {
        const node = await readyNode(relay);
        const { c, sid } = await session(relay, node);
        node.send(type, sid);
        return [await node.closed, await c.closed];
      }),
    );
    expect(cases).toEqual(Array.from({ length: 6 }, () => [CloseCode.Protocol, CloseCode.Offline]));
    const junk = await readyNode(relay);
    junk.sendRaw(Uint8Array.of(2, 0, 0));
    expect(await junk.closed).toBe(CloseCode.Protocol);
  });

  it("a non-decimal, decreasing or over-sent ack closes the socket 4402", async () => {
    const nonDecimal = await readyNode(relay);
    nonDecimal.sendRaw("a:1x");
    const leadingZero = await readyNode(relay);
    leadingZero.sendRaw("a:01");
    const over = await readyNode(relay);
    over.sendRaw(`a:${over.received() + 1}`);
    const decreasing = await readyNode(relay);
    decreasing.sendRaw(`a:${decreasing.received()}`);
    decreasing.sendRaw(`a:${decreasing.received() - 1}`);
    const closes = await Promise.all(
      [nonDecimal, leadingZero, over, decreasing].map((node) => node.closed),
    );
    expect(closes).toEqual([4402, 4402, 4402, 4402]);

    const node = await readyNode(relay);
    const { c, sid } = await session(relay, node);
    await c.send("a:1");
    expect(await c.closed).toBe(CloseCode.Protocol);
    expect(readClose((await node.expect(FrameType.Close, sid)).payload)).toBe(CloseCode.Protocol);
  });

  it("DATA past 4 MiB unacked toward a silent client ends that session 4408 and tells the node", async () => {
    const node = await readyNode(relay);
    const { c, sid } = await session(relay, node, { ack: false });
    const chunk = new Uint8Array(64 * 1024);
    for (let i = 0; i <= Limits.SOCKET_WINDOW / chunk.length; i++)
      node.send(FrameType.Data, sid, chunk);
    expect(readClose((await node.expect(FrameType.Close, sid)).payload)).toBe(CloseCode.Timeout);
    expect(await c.closed).toBe(CloseCode.Timeout);
    expect(c.received()).toBe(Limits.SOCKET_WINDOW);
  });

  it("a message of 1 MiB is forwarded and one byte more closes 1009", async () => {
    const node = await readyNode(relay);
    const { c, sid } = await session(relay, node);
    await c.send(new Uint8Array(Limits.MESSAGE_MAX));
    expect((await node.expect(FrameType.Data, sid)).payload.length).toBe(Limits.MESSAGE_MAX);
    await c.send(new Uint8Array(Limits.MESSAGE_MAX + 1));
    expect(await c.closed).toBe(CloseCode.TooBig);
    expect(readClose((await node.expect(FrameType.Close, sid)).payload)).toBe(CloseCode.TooBig);
  });

  it("ping gets pong from the relay on uplinks and clients", async () => {
    const node = await readyNode(relay);
    const { c } = await session(relay, node);
    node.sendRaw("ping");
    await c.send("ping");
    expect([await node.texts.next(), await c.texts.next()]).toEqual(["pong", "pong"]);
  });

  it("any other text closes the socket 1003", async () => {
    const node = await readyNode(relay);
    const { c, sid } = await session(relay, node);
    await c.send("hello");
    expect(await c.closed).toBe(CloseCode.Unsupported);
    expect(readClose((await node.expect(FrameType.Close, sid)).payload)).toBe(
      CloseCode.Unsupported,
    );
    node.sendRaw("hello");
    expect(await node.closed).toBe(CloseCode.Unsupported);
  });
});

describe("pen relay contract (short auth and pending timeouts)", () => {
  let relay: Relay;
  beforeAll(async () => {
    relay = await startRelay({ AUTH_TIMEOUT_MS: "300", PENDING_TIMEOUT_MS: "300" });
  });
  afterAll(async () => {
    await relay?.stop();
  });

  it("an uplink that does not answer within AUTH_TIMEOUT_MS closes 4403", async () => {
    const silent = await fakeNode(relay.url, randomSeed(), { silent: true });
    expect(await silent.closed).toBe(CloseCode.AuthFailed);
  });

  it("a session the node does not answer within PENDING_TIMEOUT_MS closes 4408 and the node hears CLOSE 4408", async () => {
    const node = await readyNode(relay);
    const { c, sid } = await session(relay, node);
    expect(await c.closed).toBe(CloseCode.Timeout);
    expect(readClose((await node.expect(FrameType.Close, sid)).payload)).toBe(CloseCode.Timeout);
  });
});

describe("pen relay contract (short idle timeout)", () => {
  let relay: Relay;
  beforeAll(async () => {
    relay = await startRelay({ IDLE_TIMEOUT_MS: "300" });
  });
  afterAll(async () => {
    await relay?.stop();
  });

  it("a socket that sends no ping within IDLE_TIMEOUT_MS closes 4408", async () => {
    // No readiness probe: the probe itself would outlive a 300 ms idle timeout.
    const node = await fakeNode(relay.url, randomSeed());
    expect(await node.closed).toBe(CloseCode.Timeout);
  });
});
