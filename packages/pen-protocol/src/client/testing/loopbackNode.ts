// A loopback Pen node for integration tests: it answers the client's Noise handshake as the daemon would, then
// carries the stream to a real TCP server (DATA, FIN and CREDIT with the 512 KiB window both ways).
// @effect-diagnostics nodeBuiltinImport:off - Bridges Pen sessions to a loopback TCP server.
import * as NodeNet from "node:net";
import type { KeyPair } from "../crypto.ts";
import type { CipherState } from "../noise.ts";
import { Kind } from "../noise.ts";
import type { RelaySocketEvent, RelaySocketFactory, RelaySocketLike } from "../relayClient.ts";
import { respond } from "./noiseResponder.ts";

const WINDOW = 512 * 1024;
const MAX_DATA = 65_518;
const CREDIT_EVERY = 64 * 1024;

export interface LoopbackNode {
  /** A relay socket factory whose every socket reaches this node. */
  readonly factory: RelaySocketFactory;
  /** Sessions this node accepted (confirmed handshakes). */
  readonly sessions: () => number;
  close(): void;
}

type Listener = (event: RelaySocketEvent) => void;

export function startLoopbackNode(options: {
  readonly nodeId: string;
  readonly key: KeyPair;
  readonly target: { readonly host: string; readonly port: number };
  readonly random: (n: number) => Uint8Array;
}): LoopbackNode {
  const live = new Set<NodeSocket>();
  let accepted = 0;

  class NodeSocket implements RelaySocketLike {
    binaryType = "arraybuffer";
    readyState = 0;
    bufferedAmount = 0;
    readonly #listeners = new Map<string, Set<Listener>>();
    #send: CipherState | undefined;
    #recv: CipherState | undefined;
    #confirmed = false;
    #tcp: NodeNet.Socket | undefined;
    #inflight = 0;
    #consumed = 0;
    #pending: Array<Uint8Array> = [];

    constructor() {
      live.add(this);
      queueMicrotask(() => {
        this.readyState = 1;
        this.#emit("open", {});
      });
    }

    addEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void {
      let set = this.#listeners.get(type);
      if (set === undefined) {
        set = new Set();
        this.#listeners.set(type, set);
      }
      set.add(listener);
    }

    removeEventListener(type: "open" | "message" | "close" | "error", listener: Listener): void {
      this.#listeners.get(type)?.delete(listener);
    }

    #emit(type: string, event: RelaySocketEvent): void {
      for (const listener of this.#listeners.get(type) ?? []) listener(event);
    }

    #deliver(data: Uint8Array | string): void {
      queueMicrotask(() => {
        if (this.readyState === 1) {
          this.#emit("message", { data: typeof data === "string" ? data : data.slice().buffer });
        }
      });
    }

    send(data: Uint8Array | string): void {
      if (typeof data === "string") {
        if (data === "ping") this.#deliver("pong");
        return;
      }
      if (this.#recv === undefined) {
        const reply = respond({
          kind: Kind.Session,
          nodeId: options.nodeId,
          localStatic: options.key,
          message1: data,
          psk: () => undefined,
          random: options.random,
        });
        this.#send = reply.send;
        this.#recv = reply.recv;
        this.#deliver(reply.message2);
        return;
      }
      const record = this.#recv.open(data);
      if (!this.#confirmed) {
        this.#confirmed = true;
        accepted += 1;
        this.#connect();
        return;
      }
      this.#onRecord(record);
    }

    #record(plaintext: Uint8Array): void {
      if (this.#send !== undefined && this.readyState === 1)
        this.#deliver(this.#send.seal(plaintext));
    }

    #connect(): void {
      const tcp = NodeNet.connect(options.target.port, options.target.host);
      this.#tcp = tcp;
      tcp.on("connect", () => {
        for (const chunk of this.#pending.splice(0)) tcp.write(chunk);
      });
      tcp.on("data", (data: Buffer) => {
        for (let at = 0; at < data.length; at += MAX_DATA) {
          const chunk = data.subarray(at, at + MAX_DATA);
          const record = new Uint8Array(chunk.length + 1);
          record.set(chunk, 1);
          this.#record(record);
          this.#inflight += chunk.length;
        }
        if (this.#inflight >= WINDOW) tcp.pause();
      });
      tcp.on("end", () => this.#record(Uint8Array.of(1)));
      tcp.on("close", () => this.close(1000));
      tcp.on("error", () => this.close(4404));
    }

    #onRecord(record: Uint8Array): void {
      const type = record[0];
      if (type === 0) {
        const data = record.subarray(1);
        if (this.#tcp?.connecting === false) this.#tcp.write(data);
        else this.#pending.push(data.slice());
        this.#consumed += data.length;
        if (this.#consumed >= CREDIT_EVERY) {
          const credit = new Uint8Array(5);
          credit[0] = 2;
          new DataView(credit.buffer).setUint32(1, this.#consumed, true);
          this.#consumed = 0;
          this.#record(credit);
        }
      } else if (type === 1) {
        this.#tcp?.end();
      } else if (type === 2) {
        this.#inflight -= new DataView(record.buffer, record.byteOffset + 1, 4).getUint32(0, true);
        if (this.#inflight < WINDOW) this.#tcp?.resume();
      }
    }

    close(code?: number): void {
      if (this.readyState >= 2) return;
      this.readyState = 3;
      live.delete(this);
      this.#tcp?.destroy();
      queueMicrotask(() => this.#emit("close", { code: code ?? 1005 }));
    }
  }

  return {
    factory: () => new NodeSocket(),
    sessions: () => accepted,
    close: () => {
      for (const socket of live) socket.close(1001);
    },
  };
}

/** A loopback target for seam tests: JSON, bodyless and large responses, and a WebSocket echo at /ws. */
export async function startTargetServer(): Promise<{
  readonly port: number;
  close(): Promise<void>;
}> {
  const { createServer } = await import("node:http");
  const { WebSocketServer } = await import("ws");
  const server = createServer((request, response) => {
    const chunks: Array<Buffer> = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const body = Buffer.concat(chunks);
      switch (request.url) {
        case "/json":
          response.writeHead(200, { "content-type": "application/json" }).end('{"ok":true}');
          return;
        case "/echo":
          response.writeHead(200, { "content-type": "application/json" }).end(body);
          return;
        case "/empty":
          response.writeHead(204).end();
          return;
        case "/not-modified":
          response.writeHead(304, { etag: '"v1"' }).end();
          return;
        case "/big":
        case "/too-big": {
          const total = 8 * 1024 * 1024 + (request.url === "/too-big" ? 1 : 0);
          response.writeHead(200, { "content-type": "application/octet-stream" });
          for (let sent = 0; sent < total; sent += 256 * 1024) {
            response.write(Buffer.alloc(Math.min(256 * 1024, total - sent), 0x61));
          }
          response.end();
          return;
        }
        default:
          response.writeHead(404).end();
      }
    });
  });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  server.on("upgrade", (request, socket, head) => {
    if (request.url !== "/ws") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      ws.on("message", (data, isBinary) => {
        if (!isBinary && data.toString() === "close-4000") ws.close(4000, "asked");
        else ws.send(data, { binary: isBinary });
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  return {
    port: typeof address === "object" && address !== null ? address.port : 0,
    close: async () => {
      for (const client of wss.clients) client.terminate();
      wss.close();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
