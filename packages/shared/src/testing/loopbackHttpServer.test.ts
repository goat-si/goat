// @effect-diagnostics nodeBuiltinImport:off - the later server is a plain Node server, as Vite's is.
import * as NodeHttp from "node:http";

import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpClient,
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

import { layerTestLoopback } from "./loopbackHttpServer.ts";

// Resolves with the bind error, or with the server once it listens; the scope closes it.
const listenLater = (port: number) =>
  Effect.acquireRelease(
    Effect.callback<NodeHttp.Server | NodeJS.ErrnoException>((resume) => {
      const server = NodeHttp.createServer((_request, response) => response.end("later server"));
      server.once("error", (error) => resume(Effect.succeed(error)));
      server.listen(port, "127.0.0.1", () => resume(Effect.succeed(server)));
    }),
    (bound) =>
      bound instanceof NodeHttp.Server
        ? Effect.callback<void>((resume) => void bound.close(() => resume(Effect.void)))
        : Effect.void,
  );

it.effect("keeps its port and the address its client dials when a later server listens", () =>
  Effect.gen(function* () {
    const address = (yield* HttpServer.HttpServer).address;
    if (!("port" in address)) return assert.fail(`not a TCP address: ${address._tag}`);
    const later = yield* listenLater(address.port);
    assert.strictEqual(later instanceof NodeHttp.Server ? "bound" : later.code, "EADDRINUSE");
    const client = yield* HttpClient.HttpClient;
    // Linux refuses the later bind against "::" too; a "::" listener still reports "::" here.
    assert.strictEqual(yield* (yield* client.get("/")).text, `${address.address}:${address.port}`);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      HttpRouter.serve(
        HttpRouter.add(
          "GET",
          "/",
          Effect.map(HttpServerRequest.HttpServerRequest, (request) =>
            HttpServerResponse.text(request.headers.host ?? ""),
          ),
        ),
        { disableListenLog: true },
      ).pipe(Layer.provideMerge(layerTestLoopback)),
    ),
  ),
);
