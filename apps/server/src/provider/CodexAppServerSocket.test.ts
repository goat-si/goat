// @effect-diagnostics nodeBuiltinImport:off - The fixture exercises Node WebSocket frames over a real Unix socket.
import * as NodeFSP from "node:fs/promises";
import * as NodeHttp from "node:http";
import * as NodePath from "node:path";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import { assert, it } from "@effect/vitest";
import { WebSocketServer } from "ws";
import { connectCodexAppServerSocket } from "./CodexAppServerSocket.ts";

it.live("fragments large messages without interleaving and preserves split UTF-8", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => NodeFSP.mkdtemp("/tmp/gcs-"));
    const server = NodeHttp.createServer();
    const wss = new WebSocketServer({ server, maxPayload: 80 * 1024 * 1024 });
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        wss.close();
        server.close();
        await NodeFSP.rm(dir, { recursive: true, force: true });
      }),
    );
    const path = NodePath.join(dir, "socket");
    server.listen(path);
    yield* Effect.promise(() => new Promise<void>((resolve) => server.once("listening", resolve)));
    const peer = new Promise<import("ws").WebSocket>((resolve) => wss.once("connection", resolve));
    const channel = yield* connectCodexAppServerSocket(path);
    const socket = yield* Effect.promise(() => peer);
    const received: string[] = [];
    let fragments = 0;
    let remain = 0;
    let header = Buffer.alloc(0);
    (socket as unknown as { _socket: import("node:net").Socket })._socket.on(
      "data",
      (chunk: Buffer) => {
        let at = 0;
        while (at < chunk.length) {
          if (remain > 0) {
            const count = Math.min(remain, chunk.length - at);
            remain -= count;
            at += count;
            continue;
          }
          header = Buffer.concat([header, chunk.subarray(at, at + 1)]);
          at++;
          if (header.length < 2) continue;
          const n = (header[1] ?? 0) & 127;
          const size = 2 + (n === 126 ? 2 : n === 127 ? 8 : 0) + 4;
          if (header.length < size) continue;
          const length =
            n === 126 ? header.readUInt16BE(2) : n === 127 ? Number(header.readBigUInt64BE(2)) : n;
          if (!((header[0] ?? 0) & 128)) fragments++;
          remain = length;
          header = Buffer.alloc(0);
        }
      },
    );
    const delivered = new Promise<void>((resolve) =>
      socket.on("message", (data) => {
        received.push(data.toString());
        if (received.length === 2) resolve();
      }),
    );
    const large = `${"a".repeat(8 * 1024 * 1024 - 1)}€${"b".repeat(12 * 1024 * 1024)}`;
    const a = yield* channel.send(large).pipe(Effect.forkScoped);
    const b = yield* channel.send("small").pipe(Effect.forkScoped);
    yield* Fiber.join(a);
    yield* Fiber.join(b);
    yield* Effect.promise(() => delivered);
    assert.deepEqual(received, [large, "small"]);
    assert.isAbove(fragments, 1);
    const error = yield* channel.send("x".repeat(64 * 1024 * 1024 + 1)).pipe(Effect.flip);
    assert.isDefined(error);
  }).pipe(Effect.scoped),
);

it.live("reports peer close and connection errors", () =>
  Effect.gen(function* () {
    const dir = yield* Effect.promise(() => NodeFSP.mkdtemp("/tmp/gcs-"));
    const server = NodeHttp.createServer();
    const wss = new WebSocketServer({ server });
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        wss.close();
        server.close();
        await NodeFSP.rm(dir, { recursive: true, force: true });
      }),
    );
    const path = NodePath.join(dir, "socket");
    server.listen(path);
    yield* Effect.promise(() => new Promise<void>((resolve) => server.once("listening", resolve)));
    const peer = new Promise<import("ws").WebSocket>((resolve) => wss.once("connection", resolve));
    const channel = yield* connectCodexAppServerSocket(path);
    const socket = yield* Effect.promise(() => peer);
    const reading = yield* channel.incoming.pipe(
      Stream.take(1),
      Stream.runCollect,
      Effect.forkScoped,
    );
    socket.send("hello");
    assert.deepEqual(yield* Fiber.join(reading), ["hello"]);
    socket.close(1000, "finished");
    const closed = yield* channel.closed;
    assert.include(String(closed.cause), "finished");
    const peer2 = new Promise<import("ws").WebSocket>((resolve) => wss.once("connection", resolve));
    const channel2 = yield* connectCodexAppServerSocket(path);
    const socket2 = yield* Effect.promise(() => peer2);
    socket2.on("error", () => {});
    (socket2 as unknown as { _socket: import("node:net").Socket })._socket.write(
      Buffer.from([0xc1, 0]),
    );
    const protocolError = yield* channel2.closed;
    assert.include(String(protocolError.cause), "RSV1");
    const failed = yield* connectCodexAppServerSocket(NodePath.join(dir, "missing")).pipe(
      Effect.flip,
    );
    assert.equal(failed._tag, "CodexAppServerSocketError");
  }).pipe(Effect.scoped),
);
