import * as NodeNet from "node:net";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

export const listenLoopback = (server: NodeNet.Server, port = 0) =>
  Effect.callback<number>((resume) => {
    const onError = (error: Error) => resume(Effect.die(error));
    server.once("error", onError);
    server.listen(port, "127.0.0.1", () => {
      server.removeListener("error", onError);
      const address = server.address();
      if (address === null || typeof address === "string")
        resume(Effect.die(new Error("Expected a loopback TCP address.")));
      else resume(Effect.succeed(address.port));
    });
    return Effect.sync(() => {
      server.removeListener("error", onError);
      if (!server.listening) server.close();
    });
  });

export const closeServer = (server: NodeNet.Server) =>
  Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve())));

export const makeStallRelay = Effect.fn("test.makeStallRelay")(function* (
  upstreamPort: number,
  localPort = 0,
) {
  const traffic = yield* Queue.unbounded<{
    direction: "upstream" | "downstream";
    forwarded: boolean;
    bytes: number;
  }>();
  let mode: "pass" | "stall" | "reset" = "pass";
  const sockets = new Set<NodeNet.Socket>();
  const server = NodeNet.createServer((downstream) => {
    if (mode === "reset") {
      downstream.resetAndDestroy();
      return;
    }
    const upstream = NodeNet.connect({ host: "127.0.0.1", port: upstreamPort });
    for (const socket of [downstream, upstream]) {
      sockets.add(socket);
      socket.on("error", () => {
        downstream.destroy();
        upstream.destroy();
      });
      socket.on("close", () => {
        sockets.delete(socket);
        downstream.destroy();
        upstream.destroy();
      });
    }
    downstream.on("end", () => upstream.end());
    upstream.on("end", () => downstream.end());
    downstream.on("data", (data: Buffer) => {
      if (mode === "pass") upstream.write(data);
      Queue.offerUnsafe(traffic, {
        direction: "upstream",
        forwarded: mode === "pass",
        bytes: data.length,
      });
    });
    upstream.on("data", (data: Buffer) => {
      if (mode === "pass") downstream.write(data);
      Queue.offerUnsafe(traffic, {
        direction: "downstream",
        forwarded: mode === "pass",
        bytes: data.length,
      });
    });
  });
  const close = Effect.suspend(() => {
    for (const socket of sockets) socket.destroy();
    return server.listening ? closeServer(server) : Effect.void;
  });
  const port = yield* Effect.acquireRelease(listenLoopback(server, localPort), () => close);
  return {
    port,
    traffic,
    get openSockets() {
      return sockets.size;
    },
    setMode(next: typeof mode) {
      mode = next;
      if (next === "reset")
        for (const socket of sockets) if (!socket.destroyed) socket.resetAndDestroy();
    },
    close,
  };
});

// The Node-only peer stays here so client-runtime can reuse the fixture without a runtime dependency.
export const makeWebSocketPeer = (onMessage: (message: string) => string | undefined) =>
  Effect.acquireRelease(
    Effect.callback<{ server: NodeWS.WebSocketServer; port: number }>((resume) => {
      const server = new NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 });
      server.once("error", (error) => resume(Effect.die(error)));
      server.once("listening", () => {
        const address = server.address();
        if (address === null || typeof address === "string")
          resume(Effect.die(new Error("Expected a TCP address.")));
        else resume(Effect.succeed({ server, port: address.port }));
      });
      server.on("connection", (socket) =>
        socket.on("message", (data) => {
          const response = onMessage(data.toString());
          if (response !== undefined) socket.send(response);
        }),
      );
    }),
    ({ server }) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            for (const socket of server.clients) socket.terminate();
            server.close(() => resolve());
          }),
      ),
  );
