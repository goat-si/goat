import { NodeWS } from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import * as Socket from "effect/socket/Socket";
import { vi } from "vite-plus/test";
import { heartbeat, HeartbeatWebSocket } from "./wsHeartbeat.ts";

// @types/ws types the ping callback's error as required; ws calls it with undefined on success.
const acknowledge = (callback: ((err: Error) => void) | undefined) =>
  (callback as ((err?: Error) => void) | undefined)?.();

it.effect("pings open sockets and contains a failed ping", () =>
  Effect.gen(function* () {
    const good = new HeartbeatWebSocket(null as unknown as string, undefined, {});
    const bad = new HeartbeatWebSocket(null as unknown as string, undefined, {});
    Object.defineProperty(good, "readyState", { value: NodeWS.WebSocket.OPEN });
    Object.defineProperty(bad, "readyState", { value: NodeWS.WebSocket.OPEN });
    const ping = vi
      .spyOn(good, "ping")
      .mockImplementation((_data, _mask, callback) => acknowledge(callback));
    vi.spyOn(bad, "ping").mockImplementation((_data, _mask, callback) =>
      callback?.(new Error("write")),
    );
    const terminate = vi.spyOn(bad, "terminate").mockImplementation(() => {});
    yield* Effect.forkScoped(heartbeat);
    yield* TestClock.adjust("60 seconds");
    assert.equal(ping.mock.calls.length, 2);
    assert.equal(terminate.mock.calls.length, 1);
    good.emit("close");
    bad.emit("close");
  }),
);

it("contains socket errors throughout its lifetime", () => {
  const socket = new HeartbeatWebSocket(null as unknown as string, undefined, {});
  const terminate = vi.spyOn(socket, "terminate").mockImplementation(() => {});
  socket.emit("error", new Error("before reader"));
  socket.emit("error", new Error("after reader"));
  assert.equal(terminate.mock.calls.length, 1);
  socket.emit("close");
});

it.effect("a real peer answers a heartbeat with inbound pong bytes", () =>
  Effect.gen(function* () {
    const server = yield* Effect.acquireRelease(
      Effect.sync(() => new NodeWS.WebSocketServer({ port: 0, WebSocket: HeartbeatWebSocket })),
      (server) => Effect.sync(() => server.close()),
    );
    const address = yield* Effect.callback<
      Exclude<ReturnType<typeof server.address>, string | null>
    >((resume) => {
      server.once("listening", () => {
        const address = server.address();
        if (address && typeof address !== "string") resume(Effect.succeed(address));
      });
      server.on("error", (error) => resume(Effect.die(error)));
    });
    const connected = Promise.withResolvers<HeartbeatWebSocket>();
    const inbound = Promise.withResolvers<void>();
    server.once("connection", (socket, request) => {
      request.socket.once("data", () => inbound.resolve());
      connected.resolve(socket);
    });
    const client = yield* Effect.acquireRelease(
      Effect.sync(() => {
        const socket = new NodeWS.WebSocket(`ws://127.0.0.1:${address.port}`);
        socket.on("error", () => socket.terminate());
        return socket;
      }),
      (socket) => Effect.sync(() => socket.terminate()),
    );
    const socket = yield* Effect.promise(() => connected.promise);
    const pong = Promise.withResolvers<void>();
    socket.once("pong", () => pong.resolve());
    yield* Effect.forkScoped(heartbeat);
    yield* TestClock.adjust("30 seconds");
    yield* Effect.promise(() => pong.promise);
    yield* Effect.promise(() => inbound.promise);
    assert.equal(client.readyState, NodeWS.WebSocket.OPEN);
  }),
);

it.effect("contains errors after the Effect reader is disposed", () =>
  Effect.gen(function* () {
    const socket = new HeartbeatWebSocket(null as unknown as string, undefined, {});
    Object.defineProperty(socket, "readyState", { value: NodeWS.WebSocket.OPEN });
    const terminate = vi.spyOn(socket, "terminate").mockImplementation(() => {});
    const transport = yield* Socket.fromWebSocket(Effect.succeed(socket));
    yield* Effect.scoped(transport.reader);
    socket.emit("error", new Error("after disposal"));
    socket.emit("error", new Error("again"));
    assert.equal(terminate.mock.calls.length, 1);
    socket.emit("close");
  }),
);

it.effect("keeps at most one heartbeat ping outstanding per socket", () =>
  Effect.gen(function* () {
    const socket = new HeartbeatWebSocket(null as unknown as string, undefined, {});
    Object.defineProperty(socket, "readyState", { value: NodeWS.WebSocket.OPEN });
    const callbacks: Array<(err: Error) => void> = [];
    const ping = vi.spyOn(socket, "ping").mockImplementation((_data, _mask, callback) => {
      if (callback) callbacks.push(callback);
    });
    yield* Effect.forkScoped(heartbeat);
    yield* TestClock.adjust("90 seconds");
    assert.equal(ping.mock.calls.length, 1);
    acknowledge(callbacks[0]);
    yield* TestClock.adjust("30 seconds");
    assert.equal(ping.mock.calls.length, 2);
    socket.emit("close");
  }),
);
