import * as NodeServices from "@effect/platform-node/NodeServices";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";
import { Rpc, RpcGroup, RpcSerialization, RpcServer } from "effect/rpc";
import { vi } from "vite-plus/test";

import * as ServerConfig from "./config.ts";
import * as Server from "./server.ts";
import { HeartbeatWebSocket } from "./wsHeartbeat.ts";
import { withWebSocketIdleTimeout } from "./wsIdleTimeout.ts";

const group = RpcGroup.make(Rpc.make("stream", { success: Schema.String, stream: true }));

const rpcRoute = Layer.unwrap(
  Effect.gen(function* () {
    const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
    yield* RpcServer.make(group).pipe(
      Effect.provideService(RpcServer.Protocol, protocol),
      Effect.provide(group.toLayerHandler("stream", () => Stream.never)),
      Effect.forkScoped,
    );
    return HttpRouter.add("GET", "/rpc", withWebSocketIdleTimeout(httpEffect));
  }),
);

// The hub, device and preview proxies upgrade through request.upgrade and read raw frames.
const rawRoute = HttpRouter.add(
  "GET",
  "/raw",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const socket = yield* request.upgrade;
    const reader = yield* socket.reader;
    yield* Effect.ignore(Effect.forever(reader.pull));
    return HttpServerResponse.empty();
  }).pipe(Effect.orDie),
);

const openClient = (url: string) =>
  Effect.acquireRelease(
    Effect.callback<NodeWS.WebSocket, Error>((resume) => {
      const socket = new NodeWS.WebSocket(url);
      socket.on("error", (error) => {
        socket.terminate();
        resume(Effect.fail(error));
      });
      socket.once("open", () => resume(Effect.succeed(socket)));
    }),
    (socket) => Effect.sync(() => socket.terminate()),
  );

const nextPing = (client: NodeWS.WebSocket) =>
  Effect.callback<void>((resume) => {
    client.once("ping", () => resume(Effect.void));
  });

it.effect(
  "the production HTTP layer pings RPC and raw upgraded sockets and stops pinging once disposed",
  () =>
    Effect.gen(function* () {
      const scope = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
      const services = yield* Layer.buildWithScope(
        HttpRouter.serve(Layer.mergeAll(rpcRoute, rawRoute), { disableListenLog: true }).pipe(
          Layer.provideMerge(Server.layerHttpServer),
          Layer.provide(RpcSerialization.layerJson),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "goat-heartbeat-" })),
          Layer.provide(NodeServices.layer),
        ),
        scope,
      );
      const origin = HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address);
      const base = origin.replace(/^http/, "ws");
      const rpc = yield* openClient(`${base}/rpc`);
      const raw = yield* openClient(`${base}/raw`);
      const pings = Effect.all([nextPing(rpc), nextPing(raw)], { concurrency: "unbounded" }).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      const pinged = yield* pings;
      yield* TestClock.adjust("30 seconds");
      yield* Fiber.join(pinged);
      rpc.terminate();
      raw.terminate();
      yield* Scope.close(scope, Exit.void);

      const orphan = new HeartbeatWebSocket(null as unknown as string, undefined, {});
      Object.defineProperty(orphan, "readyState", { value: NodeWS.WebSocket.OPEN });
      const ping = vi.spyOn(orphan, "ping").mockImplementation(() => {});
      yield* TestClock.adjust("60 seconds");
      assert.equal(ping.mock.calls.length, 0);
      orphan.emit("close");
    }),
);
