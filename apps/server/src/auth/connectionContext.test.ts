// @effect-diagnostics nodeBuiltinImport:off -- a real listener and a stray server on loopback.
import * as NodeNet from "node:net";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServer, HttpServerRequest, HttpServerResponse } from "effect/http";

import { createGuardedHttpServer } from "../httpResponseErrorGuard.ts";
import { connectionOf } from "./connectionContext.ts";

const readAll = (socket: NodeNet.Socket) =>
  Effect.callback<string>((resume) => {
    let out = "";
    socket.on("data", (chunk) => {
      out += chunk.toString();
    });
    socket.on("close", () => resume(Effect.succeed(out)));
  });
const body = (response: string) => response.slice(response.indexOf("\r\n\r\n") + 4);
const get = (port: number) =>
  Effect.suspend(() => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    socket.write("GET /context HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
    return readAll(socket);
  });

it.live(
  "the main server gives the main context only to sockets it accepted itself (mesh link design §6)",
  () =>
    Effect.gen(function* () {
      let main: NodeNet.Server | undefined;
      const services = yield* Layer.build(
        HttpRouter.serve(
          HttpRouter.add(
            "GET",
            "/context",
            Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
              HttpServerResponse.text(connectionOf(request)?.kind ?? "none"),
            ),
          ),
          { disableListenLog: true, disableLogger: true },
        ).pipe(
          Layer.provideMerge(
            NodeHttpServer.layer(
              () => {
                const server = createGuardedHttpServer();
                main = server;
                return server;
              },
              { port: 0, host: "127.0.0.1" },
            ),
          ),
        ),
      );
      const port = Number(
        new URL(HttpServer.formatAddress(Context.get(services, HttpServer.HttpServer).address))
          .port,
      );
      expect(body(yield* get(port))).toBe("main");

      // A socket accepted elsewhere and injected into the main server carries no context.
      const stray = NodeNet.createServer((socket) => main?.emit("connection", socket));
      yield* Effect.acquireRelease(
        Effect.callback<void>((resume) => {
          stray.listen(0, "127.0.0.1", () => resume(Effect.void));
        }),
        () => Effect.sync(() => stray.close()),
      );
      expect(body(yield* get((stray.address() as NodeNet.AddressInfo).port))).toBe("none");
    }).pipe(Effect.scoped),
);
