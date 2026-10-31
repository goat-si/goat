import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Tracer from "effect/Tracer";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerResponse } from "effect/http";

import { ASSET_ROUTE_PREFIX } from "./assets/AssetAccess.ts";
import { ATTACHMENT_UPLOAD_ROUTE_PREFIX } from "./assets/AttachmentUpload.ts";
import * as ServerHttp from "./http.ts";

it.effect("keeps signed asset and upload URLs out of HTTP server spans", () =>
  Effect.gen(function* () {
    const serverSpans: Array<string> = [];
    const layerTracer = Layer.succeed(
      Tracer.Tracer,
      Tracer.make({
        span: (options) => {
          if (options.kind === "server") serverSpans.push(options.name);
          return new Tracer.NativeSpan(options);
        },
      }),
    );
    const layerRoutes = Layer.effectDiscard(
      Effect.gen(function* () {
        const router = yield* HttpRouter.HttpRouter;
        yield* router.add("GET", `${ASSET_ROUTE_PREFIX}/*`, HttpServerResponse.empty());
        yield* router.add(
          "POST",
          `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/*`,
          HttpServerResponse.empty(),
        );
        yield* router.add("GET", "/api/environment", HttpServerResponse.empty());
      }),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(layerRoutes, { disableListenLog: true, disableLogger: true }).pipe(
        ServerHttp.withUntracedRequests,
        Layer.provideMerge(NodeHttpServer.layerTest),
        Layer.provide(layerTracer),
      ),
    );
    const client = Context.get(services, HttpClient.HttpClient);

    // Each URL is a bearer credential: url.full and url.path would carry it.
    for (const request of [
      HttpClientRequest.get(`${ASSET_ROUTE_PREFIX}/payload.signature/image.png`),
      HttpClientRequest.get(`${ASSET_ROUTE_PREFIX}/payload.signature/image.png?v=1`),
      HttpClientRequest.post(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/payload.signature`),
      HttpClientRequest.post(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/payload.signature?v=1`),
      HttpClientRequest.head(`${ASSET_ROUTE_PREFIX}/payload.signature/image.png`),
    ]) {
      expect((yield* client.execute(request)).status).toBe(204);
    }
    expect(serverSpans).toEqual([]);

    expect((yield* client.execute(HttpClientRequest.get("/api/environment"))).status).toBe(204);
    expect(serverSpans).toEqual(["GET"]);

    for (const path of [
      `${ASSET_ROUTE_PREFIX}-other/file`,
      `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}-other/token`,
    ]) {
      expect((yield* client.execute(HttpClientRequest.get(path))).status).toBe(404);
    }
    expect(serverSpans).toEqual(["GET", "GET", "GET"]);
  }).pipe(Effect.provide(NodeServices.layer)),
);
