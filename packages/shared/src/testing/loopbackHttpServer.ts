// @effect-diagnostics nodeBuiltinImport:off - NodeHttpServer.layer takes a Node http.Server factory.
import * as NodeHttp from "node:http";

import { NodeHttpServer } from "@effect/platform-node";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpServer } from "effect/http";

/**
 * NodeHttpServer.layerTest, listening on 127.0.0.1 where its client connects. layerTest listens
 * on "::", and a server started later on that port number, such as Vite walking its fixed ports,
 * can still bind 127.0.0.1 and take the test client's requests.
 */
export const layerTestLoopback = HttpServer.layerTestClient.pipe(
  Layer.provide(
    Layer.fresh(FetchHttpClient.layer).pipe(
      Layer.provide(Layer.succeed(FetchHttpClient.RequestInit)({ keepalive: false })),
    ),
  ),
  Layer.provideMerge(NodeHttpServer.layer(NodeHttp.createServer, { port: 0, host: "127.0.0.1" })),
);
