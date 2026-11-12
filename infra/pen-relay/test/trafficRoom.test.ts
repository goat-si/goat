// @effect-diagnostics nodeBuiltinImport:off - The test owns a scratch directory for wrangler's storage.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vite-plus/test";
import { nodeIdFromSignPub, signingKeyFromSeed } from "@goat/pen-protocol/identity";
import { CloseCode, FrameType } from "@goat/pen-protocol/wire";
import {
  client,
  type FakeNode,
  fakeNode,
  randomSeed,
  readTotals,
  type Relay,
  startRelay,
  trafficTables,
  type TotalsRow,
} from "./harness.ts";

async function nodeIdOf(seed: Uint8Array): Promise<string> {
  return nodeIdFromSignPub((await signingKeyFromSeed(seed)).signPub);
}

async function readyNode(relay: Relay, seed: Uint8Array = randomSeed()): Promise<FakeNode> {
  const node = await fakeNode(relay.url, seed);
  // ready() admits one probe session the node never answers.
  await node.ready();
  return node;
}

/**
 * A session the node answers: the client's first message, the node's reply, the client's second
 * message, then the client's close. The node has heard the CLOSE when this returns, so the Room
 * has handled the session's end.
 */
async function exchange(
  relay: Relay,
  node: FakeNode,
  first: number,
  reply: number,
  second: number,
) {
  const c = client(relay.url, node.nodeId);
  const { sid } = await node.expect(FrameType.Open);
  await c.send(new Uint8Array(first));
  expect((await node.expect(FrameType.Data, sid)).payload.length).toBe(first);
  node.send(FrameType.Data, sid, new Uint8Array(reply));
  expect((await c.messages.next()).length).toBe(reply);
  if (second > 0) {
    await c.send(new Uint8Array(second));
    expect((await node.expect(FrameType.Data, sid)).payload.length).toBe(second);
  }
  c.close(1000);
  await node.expect(FrameType.Close, sid);
}

/** A session that ends before the node answers it. */
async function unanswered(relay: Relay, node: FakeNode) {
  const c = client(relay.url, node.nodeId);
  const { sid } = await node.expect(FrameType.Open);
  await c.opened;
  c.close(1000);
  await node.expect(FrameType.Close, sid);
}

describe("Room traffic totals (a listed node, written at every session end)", () => {
  const seed = randomSeed();
  let relay: Relay;
  beforeAll(async () => {
    relay = await startRelay({ TOTALS_EVERY_MS: "0", TRAFFIC_NODES: await nodeIdOf(seed) });
  });
  afterAll(async () => {
    await relay?.stop();
  });

  it("count the bytes relayed each way, and floods of unanswered and one-byte sessions keep one row", async () => {
    const node = await readyNode(relay, seed);
    await exchange(relay, node, 1000, 3000, 5000);
    expect(readTotals(relay.persist)).toMatchObject([
      { to_node: 6000, from_node: 3000, sessions: 1, unanswered: 1 },
    ]);
    for (let i = 0; i < 30; i++) await unanswered(relay, node);
    for (let i = 0; i < 30; i++) await exchange(relay, node, 1, 1, 0);
    expect(readTotals(relay.persist)).toMatchObject([
      { to_node: 6030, from_node: 3030, sessions: 31, unanswered: 31 },
    ]);
  });

  // Anyone can mint keys and authenticate an uplink for its own node id; only listed ids get a row.
  it("keep no row for nodes outside the list, however many authenticate", async () => {
    for (let i = 0; i < 5; i++) {
      const stranger = await readyNode(relay);
      await unanswered(relay, stranger);
      await exchange(relay, stranger, 1, 1, 0);
    }
    expect(trafficTables(relay.persist)).toBe(1);
  });
});

describe("Room traffic totals (no list)", () => {
  let relay: Relay;
  beforeAll(async () => {
    relay = await startRelay({ TOTALS_EVERY_MS: "0" });
  });
  afterAll(async () => {
    await relay?.stop();
  });

  it("keep no row at all", async () => {
    const node = await readyNode(relay);
    await exchange(relay, node, 10, 10, 0);
    expect(trafficTables(relay.persist)).toBe(0);
  });
});

describe("Room traffic totals across a restart", () => {
  const persist = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pen-relay-restart-"));
  const seed = randomSeed();
  let vars: Record<string, string>;
  let before: TotalsRow | undefined;
  let second: Relay | undefined;
  // Both wrangler starts run in hooks, which have the suite's hook timeout.
  beforeAll(async () => {
    vars = { TOTALS_EVERY_MS: "0", TRAFFIC_NODES: await nodeIdOf(seed) };
    const first = await startRelay(vars, { persist });
    try {
      await exchange(first, await readyNode(first, seed), 100, 200, 300);
    } finally {
      await first.stop();
    }
    [before] = readTotals(persist);
    second = await startRelay(vars, { persist });
  });
  afterAll(async () => {
    await second?.stop();
    NodeFS.rmSync(persist, { recursive: true, force: true });
  });

  it("keep what was written before the Room restarted and add to it", async () => {
    expect(before).toMatchObject({ to_node: 400, from_node: 200, sessions: 1, unanswered: 1 });
    await exchange(second!, await readyNode(second!, seed), 10, 20, 0);
    expect(readTotals(persist)).toEqual([
      expect.objectContaining({
        to_node: 410,
        from_node: 220,
        sessions: 2,
        unanswered: 2,
        since: before!.since,
      }),
    ]);
  });
});

describe("Room traffic totals (uplinks that never authenticate)", () => {
  let relay: Relay;
  beforeAll(async () => {
    relay = await startRelay({ AUTH_TIMEOUT_MS: "300", TOTALS_EVERY_MS: "0" });
  });
  afterAll(async () => {
    await relay?.stop();
  });

  it("leave no traffic table in any Room", async () => {
    for (let i = 0; i < 3; i++) {
      const silent = await fakeNode(relay.url, randomSeed(), { silent: true });
      expect(await silent.closed).toBe(CloseCode.AuthFailed);
      // The Room handles this client after the alarm that closed the uplink, and its close waits
      // for that alarm's storage writes.
      expect(await client(relay.url, silent.nodeId).closed).toBe(CloseCode.Offline);
    }
    expect(trafficTables(relay.persist)).toBe(0);
  });
});
