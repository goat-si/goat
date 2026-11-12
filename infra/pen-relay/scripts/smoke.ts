// @effect-diagnostics nodeBuiltinImport:off globalFetch:off globalDate:off globalTimers:off globalConsole:off - A standalone script against a live relay.
// Usage: node scripts/smoke.ts [relay URL]. PEN_SMOKE_SEED (64 hex chars) fixes the node key.
import * as NodeHttp from "node:http";
import * as NodeHttps from "node:https";
import {
  fromHex,
  nodeIdFromSignPub,
  sha256,
  signingKeyFromSeed,
  toHex,
} from "@goat/pen-protocol/identity";
import {
  challengeMessage,
  decodeFrame,
  encodeFrame,
  type Frame,
  FrameType,
  Limits,
  readClose,
  relayOrigin,
} from "@goat/pen-protocol/wire";

const DEFAULT_URL = "https://pen-relay.pos090001.workers.dev";
const CHUNK = 64 * 1024;
const TOTAL = 1024 * 1024;

const base = (process.argv[2] ?? DEFAULT_URL).replace(/\/$/, "");
const wsBase = base.replace(/^http/, "ws");
const started = performance.now();
const ms = () => `${Math.round(performance.now() - started)} ms`;
const watchdog = setTimeout(() => fail("smoke did not finish within 120 s"), 120_000);

function fail(message: string): never {
  console.error(`FAIL ${message}`);
  process.exit(1);
}

class Queue<T> {
  private readonly items: Array<T> = [];
  private waiters: Array<() => void> = [];
  push(item: T): void {
    this.items.push(item);
    for (const wake of this.waiters.splice(0)) wake();
  }
  ready(): Promise<void> {
    return this.items.length > 0
      ? Promise.resolve()
      : new Promise((resolve) => this.waiters.push(resolve));
  }
  async next(): Promise<T> {
    await this.ready();
    const item = this.items.shift();
    return item === undefined ? this.next() : item;
  }
}

interface Peer {
  readonly ws: WebSocket;
  readonly binary: Queue<Uint8Array>;
  readonly closed: Promise<number>;
}

/** Counts bytes as they arrive and acks once 64 KiB arrived since the last ack. */
function open(url: string): Peer {
  const ws = new WebSocket(url);
  ws.binaryType = "arraybuffer";
  const binary = new Queue<Uint8Array>();
  let received = 0;
  let acked = 0;
  ws.addEventListener("message", (event) => {
    if (typeof event.data === "string") return;
    const bytes = new Uint8Array(event.data as ArrayBuffer);
    received += bytes.length;
    if (received - acked >= Limits.ACK_STEP && ws.readyState === WebSocket.OPEN) {
      acked = received;
      ws.send(`a:${received}`);
    }
    binary.push(bytes);
  });
  const closed = new Promise<number>((resolve) =>
    ws.addEventListener("close", (event) => resolve(event.code)),
  );
  return { ws, binary, closed };
}

const opened = (ws: WebSocket) =>
  ws.readyState === WebSocket.OPEN
    ? Promise.resolve()
    : new Promise<void>((resolve) => ws.addEventListener("open", () => resolve(), { once: true }));

function upgradeExtensions(path: string, offer: boolean): Promise<string> {
  const url = new URL(base + path);
  const request = (url.protocol === "https:" ? NodeHttps.request : NodeHttp.request)(url, {
    headers: {
      connection: "Upgrade",
      upgrade: "websocket",
      "sec-websocket-version": "13",
      "sec-websocket-key": Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString(
        "base64",
      ),
      ...(offer
        ? { "sec-websocket-extensions": "permessage-deflate; client_max_window_bits" }
        : {}),
    },
  });
  return new Promise((resolve, reject) => {
    request.once("upgrade", (response, socket) => {
      socket.destroy();
      resolve(String(response.headers["sec-websocket-extensions"] ?? "(none)"));
    });
    request.once("response", (response) => reject(new Error(`no upgrade: ${response.statusCode}`)));
    request.once("error", reject);
    request.end();
  });
}

async function hashOf(chunks: Array<Uint8Array>): Promise<string> {
  const all = new Uint8Array(chunks.reduce((n, chunk) => n + chunk.length, 0));
  let offset = 0;
  for (const chunk of chunks) {
    all.set(chunk, offset);
    offset += chunk.length;
  }
  return toHex(await sha256(all));
}

console.log(`relay ${base}`);
const health = await fetch(`${base}/healthz`);
const healthBody = await health.text();
console.log(`healthz ${health.status} ${healthBody.slice(0, 120)}`);
if (healthBody !== JSON.stringify({ ok: true, version: "pen-relay/1.0" })) fail("healthz");

const probeId = await nodeIdFromSignPub(crypto.getRandomValues(new Uint8Array(32)));
// CONTRACT: Pen dialers never offer compression, so a 101 to a dial without an offer carries no extension.
const extensions = [
  await upgradeExtensions(`/v1/client/${probeId}`, false),
  await upgradeExtensions(`/v1/node/${probeId}`, false),
];
console.log(
  `Sec-WebSocket-Extensions on the client and uplink 101 (no offer): ${extensions.join(" | ")}`,
);
if (extensions.some((value) => value !== "(none)"))
  fail("the relay added a WebSocket extension unasked");
const offered = await upgradeExtensions(`/v1/client/${probeId}`, true);
console.log(`Sec-WebSocket-Extensions when a non-Pen client offers deflate: ${offered}`);

const seed = process.env.PEN_SMOKE_SEED
  ? fromHex(process.env.PEN_SMOKE_SEED)
  : crypto.getRandomValues(new Uint8Array(32));
const key = await signingKeyFromSeed(seed);
const nodeId = await nodeIdFromSignPub(key.signPub);
const uplinkUrl = `${wsBase}/v1/node/${nodeId}`;
const node = open(uplinkUrl);
const frames = new Queue<Frame>();
void (async () => {
  const challenge = await node.binary.next();
  const signature = await key.sign(challengeMessage(relayOrigin(uplinkUrl), nodeId, challenge));
  node.ws.send(new Uint8Array([...key.signPub, ...signature]));
  for (;;) {
    const frame = decodeFrame(await node.binary.next());
    if (frame) frames.push(frame);
  }
})();
void node.closed.then((code) => console.log(`uplink closed ${code} at ${ms()}`));
const expectFrame = async (type: number, sid?: number) => {
  const frame = await frames.next();
  if (frame.type !== type || (sid !== undefined && frame.sid !== sid))
    fail(`expected frame ${type}/${sid}, got ${frame.type}/${frame.sid}`);
  return frame;
};

// The relay says nothing when auth succeeds; a client that gets OPEN through proves it.
let client: Peer | null = null;
let sid = 0;
for (let attempt = 1; client === null; attempt++) {
  if (attempt > 20) fail("uplink never became current");
  const candidate = open(`${wsBase}/v1/client/${nodeId}`);
  const outcome = await Promise.race([
    frames.ready().then(() => "open" as const),
    candidate.closed,
  ]);
  if (outcome === "open") {
    sid = (await expectFrame(FrameType.Open)).sid;
    client = candidate;
  }
}
await opened(client.ws);
console.log(`node ${nodeId} authenticated; session ${sid} open at ${ms()}`);

const toClient = Array.from({ length: TOTAL / CHUNK }, () =>
  crypto.getRandomValues(new Uint8Array(CHUNK)),
);
const toNode = Array.from({ length: TOTAL / CHUNK }, () =>
  crypto.getRandomValues(new Uint8Array(CHUNK)),
);

let t0 = performance.now();
for (const chunk of toClient) node.ws.send(encodeFrame(FrameType.Data, sid, chunk));
const clientGot: Array<Uint8Array> = [];
for (let got = 0; got < TOTAL;) {
  const bytes = await client.binary.next();
  clientGot.push(bytes);
  got += bytes.length;
}
console.log(`node -> client 1 MiB in ${Math.round(performance.now() - t0)} ms`);

t0 = performance.now();
for (const chunk of toNode) client.ws.send(chunk);
const nodeGot: Array<Uint8Array> = [];
for (let got = 0; got < TOTAL;) {
  const frame = await expectFrame(FrameType.Data, sid);
  nodeGot.push(frame.payload);
  got += frame.payload.length;
}
console.log(`client -> node 1 MiB in ${Math.round(performance.now() - t0)} ms`);

const hashes = {
  nodeToClient: [await hashOf(toClient), await hashOf(clientGot)],
  clientToNode: [await hashOf(toNode), await hashOf(nodeGot)],
};
console.log(`sha256 node->client sent ${hashes.nodeToClient[0]} got ${hashes.nodeToClient[1]}`);
console.log(`sha256 client->node sent ${hashes.clientToNode[0]} got ${hashes.clientToNode[1]}`);
if (
  hashes.nodeToClient[0] !== hashes.nodeToClient[1] ||
  hashes.clientToNode[0] !== hashes.clientToNode[1]
)
  fail("hash mismatch");

// Close latency, as a WebSocket client sees it (close event after TCP teardown).
t0 = performance.now();
node.ws.send(encodeFrame(FrameType.Close, sid, Uint8Array.of(0xa0, 0x0f)));
const relayClose = await client.closed;
console.log(
  `node CLOSE 4000 -> client close event ${relayClose} after ${Math.round(performance.now() - t0)} ms`,
);
if (relayClose !== 4000) fail("relay-initiated close code");

const second = open(`${wsBase}/v1/client/${nodeId}`);
const secondSid = (await expectFrame(FrameType.Open)).sid;
await opened(second.ws);
t0 = performance.now();
second.ws.close(4001);
const clientClose = readClose((await expectFrame(FrameType.Close, secondSid)).payload);
console.log(
  `client close 4001 -> node CLOSE ${clientClose} after ${Math.round(performance.now() - t0)} ms`,
);
if (clientClose !== 4001) fail("client-initiated close code");

node.ws.close(1000);
clearTimeout(watchdog);
console.log(`OK in ${ms()}`);
process.exit(0);
