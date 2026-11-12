// @effect-diagnostics nodeBuiltinImport:off - Differential run against the ws library over loopback sockets.
import * as NodeHttp from "node:http";
import * as NodeNet from "node:net";
import { describe, expect, it } from "vite-plus/test";
import WebSocket, { WebSocketServer } from "ws";
import { ResponseParser } from "./http1.ts";
import { seededRandom } from "./testing/seededRandom.ts";
import {
  buildUpgradeRequest,
  encodeFrame,
  type FrameEvent,
  FrameDecoder,
  Opcode,
} from "./websocket.ts";

type Step =
  | { readonly kind: "text" | "binary"; readonly parts: ReadonlyArray<Uint8Array> }
  | { readonly kind: "ping"; readonly payload: Uint8Array };

const LENGTHS = [0, 1, 125, 126, 127, 65_535, 65_536, 70_000];

function script(seed: number): { steps: Array<Step>; close: { code: number; reason: string } } {
  const rand = seededRandom(seed);
  const steps: Array<Step> = [];
  for (let i = 0; i < 40; i++) {
    const roll = rand.int(10);
    if (roll === 0) {
      steps.push({ kind: "ping", payload: rand.bytes(rand.int(126)) });
      continue;
    }
    const kind = roll < 5 ? "text" : "binary";
    const length = LENGTHS[rand.int(LENGTHS.length)] ?? 0;
    const bytes =
      kind === "text"
        ? new TextEncoder().encode(
            Array.from({ length }, () => "aé€😀"[rand.int(4)])
              .join("")
              .slice(0, length),
          )
        : rand.bytes(length);
    const pieces = 1 + rand.int(4);
    const parts: Array<Uint8Array> = [];
    // Text is split on code point boundaries by the server's fragmenting; bytes are split anywhere.
    for (let p = 0, at = 0; p < pieces; p++) {
      const end =
        p === pieces - 1 ? bytes.length : Math.min(bytes.length, at + rand.int(bytes.length + 1));
      parts.push(bytes.subarray(at, end));
      at = end;
    }
    steps.push({ kind, parts });
  }
  return { steps, close: { code: [1000, 1001, 3000, 4999][rand.int(4)] ?? 1000, reason: "done" } };
}

type Seen =
  | { type: "message"; text?: string; bytes?: Array<number> }
  | { type: "ping"; bytes: Array<number> }
  | { type: "close"; code: number; reason: string };

/** The server plays its script once it has received `awaitMessages` messages, so the order is fixed. */
async function withServer<T>(
  seed: number,
  awaitMessages: number,
  run: (port: number, received: Array<Seen>) => Promise<T>,
): Promise<T> {
  const { steps, close } = script(seed);
  const server = NodeHttp.createServer();
  const wss = new WebSocketServer({ server, perMessageDeflate: false });
  const received: Array<Seen> = [];
  wss.on("connection", (ws) => {
    const play = () => {
      for (const step of steps) {
        if (step.kind === "ping") {
          ws.ping(Buffer.from(step.payload));
          continue;
        }
        step.parts.forEach((part, i) =>
          ws.send(Buffer.from(part), {
            binary: step.kind === "binary",
            fin: i === step.parts.length - 1,
          }),
        );
      }
      ws.close(close.code, close.reason);
    };
    ws.on("message", (data, isBinary) => {
      const bytes = [...(data as Buffer)];
      received.push(
        isBinary
          ? { type: "message", bytes }
          : { type: "message", text: Buffer.from(bytes).toString("utf8") },
      );
      if (received.length === awaitMessages) play();
    });
    if (awaitMessages === 0) play();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  try {
    return await run(port, received);
  } finally {
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const toSeen = (event: FrameEvent): Seen =>
  event.type === "message"
    ? typeof event.data === "string"
      ? { type: "message", text: event.data }
      : { type: "message", bytes: [...event.data] }
    : event.type === "ping"
      ? { type: "ping", bytes: [...event.payload] }
      : { type: "close", code: event.code, reason: event.reason };

/** What the ws client records for the server's script. */
function viaWs(port: number): Promise<Array<Seen>> {
  return new Promise((resolve, reject) => {
    const seen: Array<Seen> = [];
    const ws = new WebSocket("ws://127.0.0.1:" + port, { perMessageDeflate: false });
    ws.on("message", (data, isBinary) => {
      const bytes = [...(data as Buffer)];
      seen.push(
        isBinary
          ? { type: "message", bytes }
          : { type: "message", text: Buffer.from(bytes).toString("utf8") },
      );
    });
    ws.on("ping", (data) => seen.push({ type: "ping", bytes: [...data] }));
    ws.on("close", (code, reason) => {
      seen.push({ type: "close", code, reason: reason.toString("utf8") });
      resolve(seen);
    });
    ws.on("error", reject);
  });
}

/** What our client records over a raw socket, sending back the messages it is given. */
function viaPen(port: number, replies: ReadonlyArray<string | Uint8Array>): Promise<Array<Seen>> {
  let seed = 7;
  const random = (n: number) =>
    Uint8Array.from({ length: n }, () => (seed = (seed * 131 + 17) & 255));
  return new Promise((resolve, reject) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    const request = buildUpgradeRequest({ host: "127.0.0.1:" + port, target: "/", random });
    const parser = new ResponseParser({ method: "GET", upgrade: { key: request.key }, bodyCap: 0 });
    const decoder = new FrameDecoder();
    const seen: Array<Seen> = [];
    let upgraded = false;
    socket.on("connect", () => socket.write(request.bytes));
    socket.on("error", reject);
    socket.on("data", (data: Buffer) => {
      try {
        let bytes: Uint8Array = new Uint8Array(data);
        if (!upgraded) {
          const events = parser.push(bytes);
          if (!events.some((event) => event.type === "end")) return;
          upgraded = true;
          bytes = parser.leftover();
          for (const reply of replies) {
            const payload = typeof reply === "string" ? new TextEncoder().encode(reply) : reply;
            socket.write(
              encodeFrame(typeof reply === "string" ? Opcode.Text : Opcode.Binary, payload, random),
            );
          }
        }
        decoder.feed(bytes);
        for (let event = decoder.next(); event !== null; event = decoder.next()) {
          seen.push(toSeen(event));
          if (event.type === "ping") socket.write(encodeFrame(Opcode.Pong, event.payload, random));
          if (event.type === "close") {
            socket.end(
              encodeFrame(Opcode.Close, Uint8Array.of(event.code >> 8, event.code & 255), random),
            );
            resolve(seen);
          }
        }
      } catch (error) {
        socket.destroy();
        reject(error);
      }
    });
  });
}

describe("WebSocket differential against ws (design 10.2 exit criterion)", () => {
  it.each([0x5eed_2001, 0x5eed_2002, 0x5eed_2003, 0x5eed_2004])(
    "seed %i: our decoder sees what the ws client sees, and ws reads our masked frames back unchanged",
    async (seed) => {
      const expected = await withServer(seed, 0, (port) => viaWs(port));
      const replies = [
        "hello",
        "é€😀",
        new Uint8Array(70_000).fill(9),
        new Uint8Array(0),
        "x".repeat(65_536),
      ];
      await withServer(seed, replies.length, async (port, received) => {
        expect(await viaPen(port, replies)).toEqual(expected);
        expect(received).toEqual(
          replies.map((reply) =>
            typeof reply === "string"
              ? { type: "message", text: reply }
              : { type: "message", bytes: [...reply] },
          ),
        );
      });
    },
  );
});
