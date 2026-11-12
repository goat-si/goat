// @effect-diagnostics nodeBuiltinImport:off - Test fixtures drive wrangler and raw sockets directly.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeReadline from "node:readline";
import * as NodeSqlite from "node:sqlite";
import { nodeIdFromSignPub, signingKeyFromSeed } from "@goat/pen-protocol/identity";
import { RawWebSocket } from "./rawSocket.ts";
import {
  challengeMessage,
  decodeFrame,
  encodeFrame,
  type Frame,
  FrameType,
  Limits,
  relayOrigin,
} from "@goat/pen-protocol/wire";

const PACKAGE_DIR = NodePath.join(import.meta.dirname, "..");

export interface Relay {
  readonly url: string;
  /** Where wrangler keeps the Durable Objects' storage. */
  readonly persist: string;
  stop(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = NodeNet.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      server.close(() =>
        typeof address === "object" && address
          ? resolve(address.port)
          : reject(new Error("no port")),
      );
    });
  });
}

/**
 * Runs `wrangler dev` in its own process group and resolves on its "Ready on" line. A given
 * persist directory is reused and kept on stop (a restart); otherwise a new one is removed.
 */
export async function startRelay(
  vars: Record<string, string> = {},
  options: { persist?: string } = {},
): Promise<Relay> {
  const [port, inspectorPort] = [await freePort(), await freePort()];
  const persist =
    options.persist ?? NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "pen-relay-"));
  const args = [
    "dev",
    "--ip",
    "127.0.0.1",
    "--port",
    String(port),
    "--inspector-port",
    String(inspectorPort),
  ];
  args.push(
    "--persist-to",
    persist,
    ...Object.entries(vars).flatMap(([key, value]) => ["--var", `${key}:${value}`]),
  );
  const child = NodeChildProcess.spawn(
    NodePath.join(PACKAGE_DIR, "node_modules/.bin/wrangler"),
    args,
    {
      cwd: PACKAGE_DIR,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" },
    },
  );
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const output: Array<string> = [];
  const url = await new Promise<string>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`wrangler dev exited ${code}:\n${output.join("\n")}`)),
    );
    for (const stream of [child.stdout, child.stderr]) {
      NodeReadline.createInterface({ input: stream }).on("line", (line) => {
        output.push(line);
        if (process.env.PEN_RELAY_LOG) process.stderr.write(`[wrangler] ${line}\n`);
        const match = /Ready on (http:\/\/\S+)/.exec(line);
        if (match?.[1]) resolve(match[1].replace(/\/$/, ""));
      });
    }
  });
  return {
    url,
    persist,
    stop: async () => {
      if (child.pid !== undefined && child.exitCode === null) {
        try {
          process.kill(-child.pid, "SIGTERM");
        } catch {
          // The group already exited.
        }
      }
      await exited;
      if (options.persist === undefined) NodeFS.rmSync(persist, { recursive: true, force: true });
    },
  };
}

export interface TotalsRow {
  readonly to_node: number;
  readonly from_node: number;
  readonly sessions: number;
  readonly unanswered: number;
  readonly since: number;
  readonly at: number;
}

/** Every Room's traffic row, read from the SQLite files wrangler keeps under persist. */
export function readTotals(persist: string): Array<TotalsRow> {
  const rows: Array<TotalsRow> = [];
  for (const db of trafficDatabases(persist)) {
    try {
      for (const row of db.prepare("SELECT * FROM traffic").all()) {
        rows.push({
          to_node: Number(row.to_node),
          from_node: Number(row.from_node),
          sessions: Number(row.sessions),
          unanswered: Number(row.unanswered),
          since: Number(row.since),
          at: Number(row.at),
        });
      }
    } finally {
      db.close();
    }
  }
  return rows;
}

/** How many Rooms hold a traffic table. */
export function trafficTables(persist: string): number {
  const dbs = trafficDatabases(persist);
  for (const db of dbs) db.close();
  return dbs.length;
}

function trafficDatabases(persist: string): Array<NodeSqlite.DatabaseSync> {
  const files = NodeFS.readdirSync(persist, { recursive: true, encoding: "utf8" });
  return files.flatMap((file) => {
    if (!file.endsWith(".sqlite")) return [];
    const db = new NodeSqlite.DatabaseSync(NodePath.join(persist, file), { readOnly: true });
    const table = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'traffic'")
      .get();
    if (table !== undefined) return [db];
    db.close();
    return [];
  });
}

/** Values arrive in order; `ready` resolves when one is waiting without taking it. */
export class Queue<T> {
  private readonly items: Array<T> = [];
  private waiters: Array<() => void> = [];

  push(item: T): void {
    this.items.push(item);
    const waiters = this.waiters;
    this.waiters = [];
    for (const wake of waiters) wake();
  }

  async next(): Promise<T> {
    await this.ready();
    const item = this.items.shift();
    if (item === undefined) return this.next();
    return item;
  }

  ready(): Promise<void> {
    if (this.items.length > 0) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  get size(): number {
    return this.items.length;
  }
}

interface Peer {
  readonly opened: Promise<void>;
  readonly closed: Promise<number>;
  /** Bytes received on this socket. */
  received(): number;
  /** Any code, including ones a browser WebSocket refuses to send. */
  close(code?: number): void;
  sendNow(data: Uint8Array | string): void;
}

/** Counts what arrives and acks once ACK_STEP arrived since the last ack (CONTRACT erratum 3). */
function connect(
  url: string,
  ack: boolean,
  onBinary: (bytes: Uint8Array) => void,
  onText: (text: string) => void,
): Peer {
  const ws = new RawWebSocket(url);
  let received = 0;
  let ackedAt = 0;
  ws.onText = onText;
  ws.onBinary = (bytes) => {
    received += bytes.byteLength;
    if (ack && received - ackedAt >= Limits.ACK_STEP && ws.isOpen) {
      ackedAt = received;
      ws.send(`a:${received}`);
    }
    onBinary(bytes);
  };
  return {
    opened: ws.opened,
    closed: ws.closed,
    received: () => received,
    close: (code) => ws.close(code),
    sendNow: (data) => ws.send(data),
  };
}

function wsUrl(relay: string, path: string): string {
  return relay.replace(/^http/, "ws") + path;
}

export interface Client extends Peer {
  readonly messages: Queue<Uint8Array>;
  readonly texts: Queue<string>;
  send(data: Uint8Array | string): Promise<void>;
}

export function client(relay: string, nodeId: string, options: { ack?: boolean } = {}): Client {
  const messages = new Queue<Uint8Array>();
  const texts = new Queue<string>();
  const peer = connect(
    wsUrl(relay, `/v1/client/${nodeId}`),
    options.ack ?? true,
    (bytes) => messages.push(bytes),
    (text) => texts.push(text),
  );
  return {
    ...peer,
    messages,
    texts,
    send: async (data) => {
      await peer.opened;
      peer.sendNow(data);
    },
  };
}

export interface FakeNode extends Peer {
  readonly nodeId: string;
  readonly frames: Queue<Frame>;
  readonly texts: Queue<string>;
  /** Every sid this uplink got an OPEN for, readiness probes included. */
  readonly openedSids: Array<number>;
  /** Resolves once the relay routes clients to this uplink. */
  ready(): Promise<void>;
  send(type: number, sid: number, payload?: Uint8Array): void;
  sendRaw(data: Uint8Array | string): void;
  /** Waits for a frame of this type, failing on any other. */
  expect(type: number, sid?: number): Promise<Frame>;
}

export interface FakeNodeOptions {
  readonly ack?: boolean;
  /** Replace the auth answer, e.g. to test refusals. */
  readonly answer?: (input: {
    signPub: Uint8Array;
    signature: Uint8Array;
    challenge: Uint8Array;
  }) => Uint8Array;
  /** Dial this nodeId's path instead of the key's own. */
  readonly pathNodeId?: string;
  /** Never answer the challenge. */
  readonly silent?: boolean;
  /** Answer the challenge only once this settles. */
  readonly answerAfter?: Promise<unknown>;
}

export function randomSeed(): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(32));
}

export async function fakeNode(
  relay: string,
  seed: Uint8Array,
  options: FakeNodeOptions = {},
): Promise<FakeNode> {
  const key = await signingKeyFromSeed(seed);
  const nodeId = await nodeIdFromSignPub(key.signPub);
  const path = `/v1/node/${options.pathNodeId ?? nodeId}`;
  const url = wsUrl(relay, path);
  const frames = new Queue<Frame>();
  const openedSids: Array<number> = [];
  const texts = new Queue<string>();
  let challenged = false;
  const peer = connect(
    url,
    options.ack ?? true,
    (bytes) => {
      if (challenged) {
        const frame = decodeFrame(bytes);
        if (frame?.type === FrameType.Open) openedSids.push(frame.sid);
        if (frame) frames.push({ ...frame, payload: frame.payload.slice() });
        return;
      }
      challenged = true;
      if (options.silent) return;
      const challenge = bytes.slice();
      void (options.answerAfter ?? Promise.resolve())
        .then(() =>
          key.sign(challengeMessage(relayOrigin(url), options.pathNodeId ?? nodeId, challenge)),
        )
        .then((signature) => {
          const answer =
            options.answer?.({ signPub: key.signPub, signature, challenge }) ??
            new Uint8Array([...key.signPub, ...signature]);
          peer.sendNow(answer);
        });
    },
    (text) => texts.push(text),
  );
  const node: FakeNode = {
    ...peer,
    nodeId,
    frames,
    openedSids,
    texts,
    send: (type, sid, payload) => peer.sendNow(encodeFrame(type, sid, payload)),
    sendRaw: (data) => peer.sendNow(data),
    expect: async (type, sid) => {
      const frame = await frames.next();
      if (frame.type !== type || (sid !== undefined && frame.sid !== sid)) {
        throw new Error(`expected frame ${type}/${sid ?? "*"}, got ${frame.type}/${frame.sid}`);
      }
      return frame;
    },
    // The relay sends nothing on success, so a probe client tells whether this uplink is current:
    // its OPEN arrives here, or it closes 4404 because the answer is not processed yet.
    ready: async () => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const probe = client(relay, nodeId);
        const outcome = await Promise.race([
          frames.ready().then(() => "open" as const),
          probe.closed,
        ]);
        if (outcome === "open") {
          const open = await node.expect(FrameType.Open);
          probe.close(1000);
          await node.expect(FrameType.Close, open.sid);
          return;
        }
      }
      throw new Error("uplink never became current");
    },
  };
  return node;
}
