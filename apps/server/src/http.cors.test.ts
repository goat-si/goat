import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { ORCHESTRATION_PROTOCOL_HEADER } from "@goat/contracts";
import { LEGACY_ORCHESTRATION_PROTOCOL_HEADER } from "@goat/contracts/legacyT3Names";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter, HttpServerResponse } from "effect/http";
import { describe } from "vite-plus/test";
import * as ServerConfig from "./config.ts";
import * as ServerHttp from "./http.ts";

describe("browser API CORS", () => {
  it.each(["goat://app", "t3code://app", "goat-dev://app", "t3code-dev://app"])(
    "accepts credentialed desktop preflight and GET from %s in dev",
    async (origin) => {
      const layerRoute = Layer.effectDiscard(
        Effect.gen(function* () {
          const router = yield* HttpRouter.HttpRouter;
          yield* router.add("GET", "/api/environment", HttpServerResponse.empty());
        }),
      );
      const config = Layer.effect(
        ServerConfig.ServerConfig,
        Effect.gen(function* () {
          const config = yield* ServerConfig.ServerConfig;
          return { ...config, devUrl: new URL("http://localhost:5733") };
        }),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "http-desktop-cors-" })),
      );
      const layerApp = Layer.merge(layerRoute, ServerHttp.layerBrowserApiCors).pipe(
        Layer.provide(config),
        Layer.provide(NodeServices.layer),
      );
      const { handler, dispose } = HttpRouter.toWebHandler(layerApp, { disableLogger: true });
      try {
        for (const method of ["OPTIONS", "GET"]) {
          const response = await handler(
            new Request("http://localhost:3773/api/environment", {
              method,
              headers: {
                origin,
                ...(method === "OPTIONS"
                  ? {
                      "access-control-request-method": "GET",
                      "access-control-request-headers": "authorization, dpop",
                    }
                  : {}),
              },
            }),
          );
          expect(response.status).toBe(204);
          expect(response.headers.get("access-control-allow-origin")).toBe(origin);
          expect(response.headers.get("access-control-allow-credentials")).toBe("true");
        }
      } finally {
        await dispose();
      }
    },
  );

  it("accepts protocol negotiation with authenticated browser headers", async () => {
    const layerRoute = Layer.effectDiscard(
      Effect.gen(function* () {
        const router = yield* HttpRouter.HttpRouter;
        yield* router.add("GET", "/api/environment", HttpServerResponse.empty());
      }),
    );
    const layerApp = Layer.merge(layerRoute, ServerHttp.layerBrowserApiCors).pipe(
      Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "http-cors-test-" })),
      Layer.provide(NodeServices.layer),
    );
    const { handler, dispose } = HttpRouter.toWebHandler(layerApp, { disableLogger: true });

    try {
      const response = await handler(
        new Request("https://backend.example/api/environment", {
          method: "OPTIONS",
          headers: {
            origin: "https://app.exa.test",
            "access-control-request-method": "GET",
            "access-control-request-headers": [
              ORCHESTRATION_PROTOCOL_HEADER,
              LEGACY_ORCHESTRATION_PROTOCOL_HEADER,
              "authorization",
              "dpop",
            ].join(", "),
          },
        }),
      );

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      const allowedHeaders = new Set(
        (response.headers.get("access-control-allow-headers") ?? "")
          .split(",")
          .map((header) => header.trim().toLowerCase()),
      );
      expect(allowedHeaders.has(ORCHESTRATION_PROTOCOL_HEADER)).toBe(true);
      expect(allowedHeaders.has(LEGACY_ORCHESTRATION_PROTOCOL_HEADER)).toBe(true);
      expect(allowedHeaders.has("authorization")).toBe(true);
      expect(allowedHeaders.has("dpop")).toBe(true);
    } finally {
      await dispose();
    }
  });
});
