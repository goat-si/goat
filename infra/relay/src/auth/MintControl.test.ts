import { it, expect } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { config, assertEnabled } from "./MintControl.ts";
import { layerCors } from "../http/Api.ts";
import { layer as layerMintControl } from "../http/MintControlApi.ts";
import { testConfig } from "../accounts/test/PolicyPostgresLayers.ts";
import * as Configuration from "../Config.ts";

it.effect("rejects invalid pause configuration and resumes issuance when false", () =>
  Effect.gen(function* () {
    expect(
      yield* config.pipe(Effect.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({})))),
    ).toBe(false);
    expect(
      yield* config.pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ RELAY_MINT_DISABLED: "true" })),
        ),
      ),
    ).toBe(true);
    expect(
      (yield* config.pipe(
        Effect.provide(
          ConfigProvider.layer(ConfigProvider.fromUnknown({ RELAY_MINT_DISABLED: "yes" })),
        ),
        Effect.result,
      ))._tag,
    ).toBe("Failure");
    expect((yield* Effect.flip(assertEnabled({ ...testConfig, mintDisabled: true }))).code).toBe(
      "relay_mint_disabled",
    );
    yield* assertEnabled({ ...testConfig, mintDisabled: false });
  }),
);

it.effect(
  "pause refuses every mint route before downstream work while cleanup and CORS stay available",
  () =>
    Effect.gen(function* () {
      let downstream = 0;
      const downstreamHandler = Effect.sync(() => {
        downstream++;
        return HttpServerResponse.empty({ status: 204 });
      });
      const routes = Layer.mergeAll(
        (
          [
            "/v1/client/dpop-token",
            "/v1/client/environment-link-challenges",
            "/v1/client/environment-links",
            "/v1/environments/:environmentId/connect",
            "/v1/environments/:environmentId/status",
            "/v1/environments/:environmentId/tunnel",
            "/v1/environments/:environmentId/tunnel/recovery",
          ] as const
        )
          .map((path) => HttpRouter.add("POST", path, downstreamHandler))
          .reduce((left, right) => Layer.merge(left, right)),
        HttpRouter.add("*", "/*", downstreamHandler),
      );
      const app = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            routes.pipe(
              Layer.provide([
                layerMintControl.pipe(
                  Layer.provide(Configuration.layer({ ...testConfig, mintDisabled: true })),
                ),
                layerCors,
              ]),
              Layer.provide(HttpServer.layerServices),
            ),
            { disableLogger: true },
          ),
        ),
        (app) => Effect.promise(() => app.dispose()),
      );
      for (const path of [
        "/v1/client/dpop-token",
        "//v1//client//dpop-token",
        "/v1/client/environment-link-challenges",
        "/v1/client/environment-links",
        "/v1/environments/e/connect",
        "/v1/environments/e/status",
        "/v1/environments/e/tunnel",
        "/v1/environments/e/tunnel/recovery",
      ]) {
        const response = yield* Effect.promise(() =>
          app.handler(new Request(`https://relay.example.test${path}`, { method: "POST" })),
        );
        expect(response.status).toBe(503);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(yield* Effect.promise(() => response.json())).toMatchObject({
          code: "relay_mint_disabled",
        });
      }
      expect(downstream).toBe(0);
      for (const path of [
        "/v1/client/account",
        "/v1/webhooks/clerk",
        "/v1/environments/e/cloud-revocation/ack",
      ])
        expect(
          (yield* Effect.promise(() =>
            app.handler(new Request(`https://relay.example.test${path}`, { method: "POST" })),
          )).status,
        ).toBe(204);
      expect(downstream).toBe(3);
      const preflight = yield* Effect.promise(() =>
        app.handler(
          new Request("https://relay.example.test/v1/client/account", {
            method: "OPTIONS",
            headers: {
              origin: "https://app.example.test",
              "access-control-request-method": "DELETE",
              "access-control-request-headers": "idempotency-key,authorization",
            },
          }),
        ),
      );
      expect(preflight.status).toBeLessThan(400);
    }),
);
