import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import {
  RelayApi,
  RelayAgentActivitySnapshotEndpoint,
  RelayDpopClientAuth,
  RelayMobileClientId,
  RelayRateLimitExceededError,
  RelayProtectedError,
} from "@goat/contracts/relay";
import { ACCOUNT_ENDPOINT_POLICY } from "./AccountPolicy.ts";
import { layerDpopClientAuth } from "./Api.ts";
import { RelayTokens } from "../auth/RelayTokens.ts";
import { policyUnitLayer } from "../accounts/test/PolicyUnitLayers.ts";

it("classifies every authenticated endpoint by its typed endpoint name", () => {
  for (const group of [
    RelayApi.groups.client,
    RelayApi.groups.dpopClient,
    RelayApi.groups.mobile,
    RelayApi.groups.server,
    RelayApi.groups.token,
  ])
    for (const endpoint of Object.values(group.endpoints))
      expect(Object.hasOwn(ACCOUNT_ENDPOINT_POLICY, endpoint.identifier), endpoint.identifier).toBe(
        true,
      );
});
it.effect(
  "encodes policy errors through real DPoP middleware with matching Retry-After and no-store",
  () =>
    Effect.gen(function* () {
      const api = HttpApi.make("PolicyFixture").add(
        HttpApiGroup.make("policy")
          .add(RelayAgentActivitySnapshotEndpoint)
          .middleware(RelayDpopClientAuth),
      );
      const handlers = HttpApiBuilder.group(api, "policy", (h) =>
        h.handle("getAgentActivitySnapshot", () =>
          Effect.fail(
            new RelayRateLimitExceededError({
              code: "rate_limit_exceeded",
              operation: "connect",
              retryAfterSeconds: 42,
              traceId: "fixture",
            }),
          ),
        ),
      );
      const auth = layerDpopClientAuth.pipe(
        Layer.provide(policyUnitLayer),
        Layer.provide(
          Layer.mock(RelayTokens, {
            verifyDpopAccessToken: () =>
              Effect.succeed({
                iss: "https://relay.example.test",
                aud: "https://relay.example.test",
                sub: "fixture",
                account_epoch: 1,
                jti: "fixture-token",
                iat: 0,
                exp: 100,
                client_id: RelayMobileClientId,
                scope: [],
                cnf: { jkt: "fixture-key" },
              }),
          }),
        ),
      );
      const app = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(api).pipe(
              Layer.provide(handlers),
              Layer.provide(auth),
              Layer.provide(HttpServer.layerServices),
            ),
            { disableLogger: true },
          ),
        ),
        (app) => Effect.promise(() => app.dispose()),
      );
      const response = yield* Effect.promise(() =>
        app.handler(
          new Request("https://relay.example.test/v1/mobile/agent-activity", {
            headers: { authorization: "DPoP fixture-token" },
          }),
        ),
      );
      expect(response.status).toBe(429);
      expect(response.headers.get("retry-after")).toBe("42");
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = yield* Effect.promise(() => response.json());
      expect((yield* Schema.decodeUnknownEffect(RelayProtectedError)(body))._tag).toBe(
        "RelayRateLimitExceededError",
      );
    }),
);
