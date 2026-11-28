import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as References from "effect/References";
import * as Tracer from "effect/Tracer";
import { HttpClient, HttpClientRequest, HttpRouter, HttpServerResponse } from "effect/http";

import { ASSET_ROUTE_PREFIX } from "./assets/AssetAccess.ts";
import { ATTACHMENT_UPLOAD_ROUTE_PREFIX } from "./assets/AttachmentUpload.ts";
import * as ServerHttp from "./http.ts";
import { WEBHOOK_ROUTE_PREFIX } from "./scheduledTasks/ScheduledTaskService.ts";
import { layerTestLoopback } from "@goat/shared/testing/loopbackHttpServer";

it.effect("keeps signed URLs out of HTTP server spans and request logs", () =>
  Effect.gen(function* () {
    const serverSpans: Array<string> = [];
    const loggedUrls: Array<unknown> = [];
    const layerLogger = Logger.layer(
      [
        Logger.make(({ fiber }) => {
          const url = fiber.getRef(References.CurrentLogAnnotations)["http.url"];
          if (url !== undefined) loggedUrls.push(url);
        }),
      ],
      { mergeWithExisting: false },
    );
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
        yield* router.add("POST", `${WEBHOOK_ROUTE_PREFIX}/*`, HttpServerResponse.empty());
        yield* router.add("GET", "/api/environment", HttpServerResponse.empty());
      }),
    ).pipe(Layer.provide(ServerHttp.layerUnloggedSignedRequests));
    const services = yield* Layer.build(
      HttpRouter.serve(layerRoutes, { disableListenLog: true }).pipe(
        ServerHttp.withUntracedRequests,
        Layer.provideMerge(layerTestLoopback),
        Layer.provide(layerTracer),
        Layer.provide(layerLogger),
      ),
    );
    const client = Context.get(services, HttpClient.HttpClient);

    // Each URL is a bearer credential: url.full and url.path would carry it.
    for (const request of [
      HttpClientRequest.get(`${ASSET_ROUTE_PREFIX}/payload.signature/image.png`),
      HttpClientRequest.get(`${ASSET_ROUTE_PREFIX}/payload.signature/image.png?v=1`),
      HttpClientRequest.post(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/payload.signature`),
      HttpClientRequest.post(`${ATTACHMENT_UPLOAD_ROUTE_PREFIX}/payload.signature?v=1`),
      HttpClientRequest.post(`${WEBHOOK_ROUTE_PREFIX}/task-1/webhook-token`),
      HttpClientRequest.head(`${ASSET_ROUTE_PREFIX}/payload.signature/image.png`),
    ]) {
      expect((yield* client.execute(request)).status).toBe(204);
    }
    expect(serverSpans).toEqual([]);
    expect(loggedUrls).toEqual([]);

    expect((yield* client.execute(HttpClientRequest.get("/api/environment"))).status).toBe(204);
    expect(serverSpans).toEqual(["GET"]);
    expect(loggedUrls).toEqual(["/api/environment"]);

    for (const path of [
      `${ASSET_ROUTE_PREFIX}-other/file`,
      `${ATTACHMENT_UPLOAD_ROUTE_PREFIX}-other/token`,
    ]) {
      expect((yield* client.execute(HttpClientRequest.get(path))).status).toBe(404);
    }
    expect(serverSpans).toEqual(["GET", "GET", "GET"]);
    expect(loggedUrls).toHaveLength(3);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("starts an independent root trace for each incoming request", () =>
  Effect.gen(function* () {
    const requestSpans: Array<Tracer.NativeSpan> = [];
    const layerTracer = Layer.succeed(
      Tracer.Tracer,
      Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          if (options.kind === "server") requestSpans.push(span);
          return span;
        },
      }),
    );
    const routes = Layer.effectDiscard(
      Effect.gen(function* () {
        yield* (yield* HttpRouter.HttpRouter).add(
          "GET",
          "/api/environment",
          HttpServerResponse.empty(),
        );
      }),
    );
    const services = yield* Layer.build(
      HttpRouter.serve(routes, { disableListenLog: true, disableLogger: true }).pipe(
        ServerHttp.withRootRequestSpans,
        Layer.provideMerge(layerTestLoopback),
      ),
    ).pipe(Effect.withSpan("server.lifetime"), Effect.provide(layerTracer));
    const client = Context.get(services, HttpClient.HttpClient);
    for (let i = 0; i < 2; i++)
      yield* client
        .execute(HttpClientRequest.get("/api/environment"))
        .pipe(Effect.provideService(HttpClient.TracerPropagationEnabled, false));
    expect(requestSpans.map((span) => span.parent._tag)).toEqual(["None", "None"]);
    expect(new Set(requestSpans.map((span) => span.traceId)).size).toBe(2);
  }).pipe(Effect.provide(NodeServices.layer)),
);
