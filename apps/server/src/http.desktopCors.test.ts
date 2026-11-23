import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/http";
import * as ServerConfig from "./config.ts";
import * as ServerHttp from "./http.ts";

it("allows originless desktop requests in dev mode while still rejecting disallowed browser origins", async () => {
  const layerRoute = Layer.effectDiscard(
    Effect.gen(function* () {
      const router = yield* HttpRouter.HttpRouter;
      yield* router.add(
        "GET",
        "/api/environment",
        HttpServerResponse.empty({ headers: { vary: "Accept-Encoding" } }),
      );
    }),
  );
  const layerDevConfig = Layer.effect(
    ServerConfig.ServerConfig,
    Effect.map(ServerConfig.ServerConfig, (config) => ({
      ...config,
      devUrl: new URL("http://127.0.0.1:5733"),
    })),
  ).pipe(Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "http-dev-cors-test-" })));
  const layerApp = Layer.merge(layerRoute, ServerHttp.layerBrowserApiCors).pipe(
    Layer.provide(layerDevConfig),
    Layer.provide(NodeServices.layer),
  );
  const { handler, dispose } = HttpRouter.toWebHandler(layerApp, { disableLogger: true });

  try {
    const originless = await handler(
      new Request("https://dev.example/api/environment", { method: "GET" }),
    );
    expect(originless.headers.get("access-control-allow-origin")).toBe("*");
    expect(originless.headers.get("access-control-allow-credentials")).toBeNull();
    expect(originless.headers.get("vary")).toBe("Accept-Encoding, Origin");

    const originlessPreflight = await handler(
      new Request("https://dev.example/api/environment", { method: "OPTIONS" }),
    );
    expect(originlessPreflight.status).toBe(204);
    expect(originlessPreflight.headers.get("access-control-allow-origin")).toBe("*");
    expect(originlessPreflight.headers.get("vary")).toBe("Origin");

    const allowed = await handler(
      new Request("https://dev.example/api/environment", {
        method: "GET",
        headers: { origin: "http://127.0.0.1:5733" },
      }),
    );
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:5733");
    expect(allowed.headers.get("access-control-allow-credentials")).toBe("true");

    const disallowed = await handler(
      new Request("https://dev.example/api/environment", {
        method: "GET",
        headers: { origin: "https://evil.example" },
      }),
    );
    expect(disallowed.headers.get("access-control-allow-origin")).toBeNull();
  } finally {
    await dispose();
  }
});
