import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import { createPostgresFixture } from "../accounts/test/PostgresFixture.ts";
import { postgresPolicyLayer } from "../accounts/test/PolicyPostgresLayers.ts";
import { AccountOperatorSecret, layer } from "./AccountAdminApi.ts";
import { HookInboxError } from "../hooks/HookInbox.ts";
import { it, expect } from "@effect/vitest";
import * as Redacted from "effect/Redacted";
import { operatorAuthenticated } from "./AccountAdminApi.ts";

it("operator authorization accepts only the configured secret and never a client bearer", () => {
  const secret = Redacted.make("fixture-operator-secret");
  expect(operatorAuthenticated(undefined, secret)).toBe(false);
  expect(operatorAuthenticated("Bearer fixture-client-session", secret)).toBe(false);
  expect(operatorAuthenticated("Bearer fixture-operator-secret extra", secret)).toBe(false);
  expect(operatorAuthenticated(`Bearer ${"x".repeat(5000)}`, secret)).toBe(false);
  expect(operatorAuthenticated("Bearer fixture-operator-secret", secret)).toBe(true);
});

it.live(
  "authenticated operator HTTP validates idempotency and bodies, resumes pending operations, and redacts dependency failures",
  () =>
    Effect.gen(function* () {
      using pg = createPostgresFixture();
      pg.migrate();
      pg.query(
        "INSERT INTO relay_account_access(user_id,status,account_epoch) VALUES ('owner','allowed',1); INSERT INTO relay_endpoint_identities(stage,user_id,environment_id) VALUES ('test_stage','owner','env')",
      );
      let unavailable = true;
      const services = postgresPolicyLayer(pg, {
        clear: () =>
          unavailable
            ? Effect.fail(
                new HookInboxError({
                  operation: "clear",
                  endpointKey: "fixture",
                  cause: "private-provider-secret",
                }),
              )
            : Effect.void,
      });
      const app = yield* Effect.acquireRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            layer.pipe(
              Layer.provide(
                Layer.succeed(AccountOperatorSecret, Redacted.make("fixture-operator-secret")),
              ),
              Layer.provide(services),
              Layer.provide(HttpServer.layerServices),
            ),
            { disableLogger: true },
          ),
        ),
        (app) => Effect.promise(() => app.dispose()),
      );
      const request = (
        path: string,
        options: { auth?: string; key?: string; body?: string; method?: string } = {},
      ) =>
        Effect.promise(() =>
          app.handler(
            new Request(`https://relay.example.test/internal/admin/${path}`, {
              method: options.method ?? "POST",
              headers: {
                authorization: options.auth ?? "Bearer fixture-operator-secret",
                "content-type": "application/json",
                ...(options.key ? { "idempotency-key": options.key } : {}),
              },
              ...(options.method === "GET" ? {} : { body: options.body ?? "{}" }),
            }),
          ),
        );
      expect(
        (yield* request("accounts/owner/suspend", {
          auth: "Bearer client-session",
          key: "suspend",
        })).status,
      ).toBe(401);
      expect((yield* request("accounts/owner/suspend")).status).toBe(400);
      expect(
        (yield* request("accounts/owner/suspend", { key: "suspend", body: '{"status":"allowed"}' }))
          .status,
      ).toBe(400);
      expect(pg.query("SELECT status FROM relay_account_access").trim()).toBe("allowed");
      const pending = yield* request("accounts/owner/suspend", { key: "suspend" });
      expect(pending.status).toBe(202);
      const operation = yield* Effect.promise(() => pending.json());
      if (
        typeof operation !== "object" ||
        operation === null ||
        !("id" in operation) ||
        typeof operation.id !== "string"
      )
        throw new Error("Missing operation id");
      expect((yield* request("accounts/owner/allow", { key: "suspend" })).status).toBe(409);
      const resumed = yield* request(`account-operations/${operation.id}/resume`);
      expect(resumed.status).toBe(202);
      expect(yield* Effect.promise(() => resumed.text())).not.toContain("private-provider-secret");
      const duplicate = yield* request("accounts/owner/suspend", { key: "suspend" });
      expect(yield* Effect.promise(() => duplicate.json())).toMatchObject({ id: operation.id });
      unavailable = false;
      expect((yield* request(`account-operations/${operation.id}/resume`)).status).toBe(200);
      const allowed = yield* request("accounts/owner/allow", { key: "allow" });
      expect(allowed.status).toBe(200);
      expect(allowed.headers.get("cache-control")).toBe("no-store");
      pg.query("ALTER TABLE relay_account_access RENAME TO fixture_unavailable_access");
      const failed = yield* request("accounts/owner", { method: "GET" });
      expect(failed.status).toBe(503);
      expect(yield* Effect.promise(() => failed.json())).toEqual({
        code: "authorization_unavailable",
      });
    }),
);
