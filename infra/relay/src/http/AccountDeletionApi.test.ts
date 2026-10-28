import { createClerkClient, verifyToken } from "@clerk/backend";
import { vi } from "vite-plus/test";
import { it, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as OpenApi from "effect/http-api/OpenApi";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import { RelayApi } from "@goat/contracts/relay";
import * as DeletionApi from "./AccountDeletionApi.ts";
import * as Authentication from "../auth/AccountDeletionAuthentication.ts";
import * as Lifecycle from "../accounts/AccountLifecycle.ts";
import * as Configuration from "../Config.ts";
import { testConfig } from "../accounts/test/PolicyPostgresLayers.ts";

vi.mock("@clerk/backend", () => ({ createClerkClient: vi.fn(), verifyToken: vi.fn() }));
it.effect(
  "raw deletion HTTP rejects stale MFA, OAuth, inactive sessions and provider failures without accepting deletion",
  () =>
    Effect.gen(function* () {
      using _clock = vi.spyOn(Date, "now").mockReturnValue(0);
      let ages: [number, number] = [10, 0];
      let active = true;
      let providerFails = false;
      let oauth = false;
      let accepted = 0;
      vi.mocked(verifyToken).mockImplementation(
        async () =>
          ({
            iss: "https://clerk.example.test",
            sub: "fixture-owner",
            __raw: "fixture-token",
            ...(oauth ? {} : { sid: "fixture-session", v: 2 as const }),
            aud: testConfig.clerkJwtAudience,
            azp: "https://app.example.test",
            iat: 0,
            nbf: 0,
            exp: 10000,
            fva: ages,
          }) as Awaited<ReturnType<typeof verifyToken>>,
      );
      vi.mocked(createClerkClient, { partial: true, deep: true }).mockReturnValue({
        sessions: {
          getSession: async () => {
            if (providerFails) throw new Error("fixture outage");
            return {
              id: "fixture-session",
              clientId: "fixture-client",
              status: active ? "active" : "revoked",
              userId: "fixture-owner",
              lastActiveAt: 0,
              expireAt: 10000,
              abandonAt: 10000,
              createdAt: 0,
              updatedAt: 0,
              actor: null,
            };
          },
        },
      });
      const config = Configuration.layer({
        ...testConfig,
        clerkSessionIssuer: "https://clerk.example.test",
        clerkAuthorizedParties: ["https://app.example.test"],
      });
      const handlers = DeletionApi.layerAccount.pipe(
        Layer.provideMerge(Authentication.layer),
        Layer.provide(config),
        Layer.provide(
          Layer.mock(Lifecycle.AccountLifecycle)({
            getDeletion: () => Effect.succeed({ status: "absent" as const }),
            requestDelete: () =>
              Effect.sync(() => {
                accepted++;
                return {
                  status: "progress" as const,
                  operationId: "10000000-0000-4000-8000-000000000001",
                  relayState: "erasing" as const,
                  step: "relay_denied" as const,
                  relayDenied: true as const,
                  hostCleanup: { pending: 0, acknowledged: 0, unsupported: 0 },
                  endpointCleanup: "pending" as const,
                  identityAction: "delete_clerk_user" as const,
                  traceId: "fixture",
                };
              }),
          }),
        ),
      );
      const app = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            HttpApiBuilder.layer(HttpApi.make("RelayApi").add(RelayApi.groups.account)).pipe(
              Layer.provide(handlers),
              Layer.provide(HttpServer.layerServices),
            ),
            { disableLogger: true },
          ),
        ),
        (app) => Effect.promise(() => app.dispose()),
      );
      const send = () =>
        Effect.promise(() =>
          app.handler(
            new Request("https://relay.example.test/v1/client/account", {
              method: "DELETE",
              headers: {
                authorization: "Bearer fixture-token",
                "idempotency-key": "10000000-0000-4000-8000-000000000002",
              },
            }),
          ),
        );
      expect((yield* send()).status).toBe(403);
      oauth = true;
      expect((yield* send()).status).toBe(403);
      oauth = false;
      ages = [0, 0];
      active = false;
      expect((yield* send()).status).toBe(403);
      active = true;
      providerFails = true;
      expect((yield* send()).status).toBe(503);
      providerFails = false;
      expect(accepted).toBe(0);
      const response = yield* send();
      expect(response.status).toBe(202);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(accepted).toBe(1);
    }),
);

it("OpenAPI declares both pending and completed deletion status codes", () => {
  expect(OpenApi.fromApi(RelayApi)).toMatchObject({
    paths: {
      "/v1/client/account": {
        delete: { responses: { "200": {}, "202": {}, "403": {}, "503": {} } },
      },
    },
  });
});
