import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeHttpServerRequest from "@effect/platform-node/NodeHttpServerRequest";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpRouter, HttpServer, HttpServerRequest } from "effect/http";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";

import { withWebSocketIdleTimeout } from "./wsIdleTimeout.ts";

const group = RpcGroup.make(Rpc.make("stream", { success: Schema.String, stream: true }));

const startServer = Effect.fnUntraced(function* (sendOutput = false) {
  const streamClosed = yield* Deferred.make<void>();
  const connected =
    yield* Deferred.make<ReturnType<typeof NodeHttpServerRequest.toIncomingMessage>["socket"]>();
  const routes = Layer.unwrap(
    Effect.gen(function* () {
      const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
      yield* RpcServer.make(group).pipe(
        Effect.provideService(RpcServer.Protocol, protocol),
        Effect.provide(
          group.toLayerHandler("stream", () =>
            Stream.concat(
              Stream.make("started"),
              sendOutput
                ? Stream.fromEffect(Effect.as(Effect.sleep("30 seconds"), "still running"))
                : Stream.never,
            ).pipe(
              Stream.concat(Stream.never),
              Stream.ensuring(Deferred.succeed(streamClosed, undefined)),
            ),
          ),
        ),
        Effect.forkScoped,
      );
      return HttpRouter.add(
        "GET",
        "/ws",
        Effect.gen(function* () {
          const request = yield* HttpServerRequest.HttpServerRequest;
          yield* Deferred.succeed(
            connected,
            NodeHttpServerRequest.toIncomingMessage(request).socket,
          );
          return yield* withWebSocketIdleTimeout(httpEffect);
        }),
      );
    }),
  );
  const services = yield* Layer.build(
    HttpRouter.serve(routes, { disableListenLog: true }).pipe(
      Layer.provideMerge(NodeHttpServer.layerTest),
      Layer.provide(RpcSerialization.layerJson),
    ),
  );
  const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
  return { url: `${origin.replace(/^http/, "ws")}/ws`, streamClosed, connected };
});

const connect = Effect.fnUntraced(function* (url: string) {
  const closed = Promise.withResolvers<void>();
  const client = yield* Effect.acquireRelease(
    Effect.sync(() => {
      const socket = new NodeWS.WebSocket(url);
      socket.once("close", () => closed.resolve());
      return socket;
    }),
    (socket) => Effect.sync(() => socket.terminate()),
  );
  yield* Effect.callback<void, Error>((resume) => {
    client.once("open", () => resume(Effect.void));
    client.once("error", (error) => resume(Effect.fail(error)));
  });
  return { client, closed: Effect.promise(() => closed.promise) };
});

const receive = (
  client: NodeWS.WebSocket,
  send?: () => void,
  event: "message" | "pong" = "message",
) =>
  Effect.callback<string>((resume) => {
    const onFrame = (data: NodeWS.RawData) => resume(Effect.succeed(data.toString()));
    client.once(event, onFrame);
    send?.();
    return Effect.sync(() => client.off(event, onFrame));
  });

const subscribe = (client: NodeWS.WebSocket) =>
  receive(client, () =>
    client.send(
      JSON.stringify({ _tag: "Request", id: "1", tag: "stream", payload: null, headers: [] }),
    ),
  );

it.effect("closes a silent real socket at 120 seconds", () =>
  Effect.gen(function* () {
    const server = yield* startServer();
    const { client, closed } = yield* connect(server.url);
    const transport = yield* Deferred.await(server.connected);
    yield* TestClock.adjust("119 seconds");
    assert.isFalse(transport.destroyed);
    assert.equal(client.readyState, NodeWS.WebSocket.OPEN);
    yield* TestClock.adjust("1 second");
    assert.isTrue(transport.destroyed);
    yield* closed;
    assert.equal(client.readyState, NodeWS.WebSocket.CLOSED);
  }),
);

it.effect("an ordinary RPC frame resets the idle deadline", () =>
  Effect.gen(function* () {
    const server = yield* startServer();
    const { client, closed } = yield* connect(server.url);
    yield* TestClock.adjust("50 seconds");
    assert.include(yield* subscribe(client), "started");
    yield* TestClock.adjust("119 seconds");
    assert.equal(client.readyState, NodeWS.WebSocket.OPEN);
    yield* TestClock.adjust("1 second");
    yield* closed;
    yield* Deferred.await(server.streamClosed);
  }),
);

it.effect.each(
  (["rpc", "control"] as const).flatMap((kind) => [5, 60, 65, 110].map((gap) => ({ kind, gap }))),
)(
  "keeps a long-running stream alive with $gap-second $kind pings, then reaps it after silence",
  ({ kind, gap }) =>
    Effect.gen(function* () {
      const server = yield* startServer();
      const { client, closed } = yield* connect(server.url);
      assert.include(yield* subscribe(client), "started");
      for (let index = 0; index < 14; index++) {
        yield* TestClock.adjust(`${gap} seconds`);
        if (kind === "rpc") {
          assert.deepEqual(
            JSON.parse(yield* receive(client, () => client.send('{"_tag":"Ping"}'))),
            { _tag: "Pong" },
          );
        } else {
          yield* receive(client, () => client.ping(), "pong");
        }
        assert.equal(client.readyState, NodeWS.WebSocket.OPEN);
      }
      yield* TestClock.adjust("119 seconds");
      assert.equal(client.readyState, NodeWS.WebSocket.OPEN);
      yield* TestClock.adjust("1 second");
      yield* closed;
      yield* Deferred.await(server.streamClosed);
    }),
);

it.effect("outbound stream frames do not keep an abandoned client alive", () =>
  Effect.gen(function* () {
    const server = yield* startServer(true);
    const { client, closed } = yield* connect(server.url);
    assert.include(yield* subscribe(client), "started");
    client.send('{"_tag":"Ack","requestId":"1"}');
    yield* receive(client, () => client.send('{"_tag":"Ping"}'));
    const output = yield* receive(client).pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("30 seconds");
    assert.include(yield* Fiber.join(output), "still running");
    yield* TestClock.adjust("89 seconds");
    assert.equal(client.readyState, NodeWS.WebSocket.OPEN);
    yield* TestClock.adjust("1 second");
    yield* closed;
    yield* Deferred.await(server.streamClosed);
  }),
);

// TestClock.setTime also advances sleepers; override only wall time to isolate jumps.
it.effect.each([120_000, -120_000])(
  "keeps the monotonic deadline when wall time jumps by %i ms independently of TestClock elapsed time",
  (jump) =>
    Effect.gen(function* () {
      const clock = yield* Clock.Clock;
      let wallOffset = 0;
      const currentTimeMillisUnsafe = () => clock.currentTimeMillisUnsafe() + wallOffset;
      const currentTimeNanosUnsafe = () =>
        clock.currentTimeNanosUnsafe() + BigInt(wallOffset) * 1_000_000n;
      const server = yield* startServer().pipe(
        Effect.provideService(Clock.Clock, {
          ...clock,
          currentTimeMillisUnsafe,
          currentTimeMillis: Effect.sync(currentTimeMillisUnsafe),
          currentTimeNanosUnsafe,
          currentTimeNanos: Effect.sync(currentTimeNanosUnsafe),
        }),
      );
      const { client, closed } = yield* connect(server.url);
      const transport = yield* Deferred.await(server.connected);
      yield* TestClock.adjust("50 seconds");
      yield* receive(client, () => client.send('{"_tag":"Ping"}'));
      const beforeWall = currentTimeMillisUnsafe();
      const beforeElapsed = clock.monotonicTimeNanosUnsafe();
      wallOffset = jump;
      assert.equal(currentTimeMillisUnsafe() - beforeWall, jump);
      assert.equal(clock.monotonicTimeNanosUnsafe(), beforeElapsed);
      yield* TestClock.adjust("119 seconds");
      assert.isFalse(transport.destroyed);
      assert.equal(client.readyState, NodeWS.WebSocket.OPEN);
      yield* TestClock.adjust("1 second");
      assert.isTrue(transport.destroyed);
      yield* closed;
    }),
);
