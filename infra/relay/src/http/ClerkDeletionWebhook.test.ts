// @effect-diagnostics nodeBuiltinImport:off -- Synthetic signed webhook fixture only.
import { createHmac } from "node:crypto";
import { it, expect } from "@effect/vitest";
import { vi } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServer from "effect/http/HttpServer";
import * as Webhook from "./ClerkDeletionWebhook.ts";
import * as Lifecycle from "../accounts/AccountLifecycle.ts";
import * as Configuration from "../Config.ts";
import { testConfig } from "../accounts/test/PolicyPostgresLayers.ts";

it.effect(
  "only a valid raw signed deletion event commits lifecycle acceptance; tampering and missing subjects fail closed",
  () =>
    Effect.gen(function* () {
      using clock = vi.spyOn(Date, "now").mockReturnValue(0);
      const secret = Buffer.from("fixture-webhook-key-material-32-bytes");
      const accepted: string[] = [];
      const routes = Webhook.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Configuration.layer({
              ...testConfig,
              clerkWebhookSigningSecret: Redacted.make(`whsec_${secret.toString("base64")}`),
            }),
            Layer.mock(Lifecycle.AccountLifecycle)({
              requestDelete: (input) =>
                Effect.sync(() => {
                  accepted.push(input.userId);
                  return { status: "deleted" as const, deletedAt: "fixture" };
                }),
            }),
          ),
        ),
        Layer.provide(HttpServer.layerServices),
      );
      const app = yield* Effect.acquireRelease(
        Effect.sync(() => HttpRouter.toWebHandler(routes, { disableLogger: true })),
        (app) => Effect.promise(() => app.dispose()),
      );
      const send = (raw: string, signatureBody = raw) => {
        const signature = createHmac("sha256", secret)
          .update(`fixture-id.0.${signatureBody}`)
          .digest("base64");
        return Effect.promise(() =>
          app.handler(
            new Request("https://relay.example.test/v1/webhooks/clerk", {
              method: "POST",
              headers: {
                "svix-id": "fixture-id",
                "svix-timestamp": "0",
                "svix-signature": `v1,${signature}`,
                "content-type": "application/json",
              },
              body: raw,
            }),
          ),
        );
      };
      const raw = JSON.stringify({ type: "user.deleted", data: { id: "fixture-a" } });
      expect((yield* send(raw, raw + "tampered")).status).toBe(400);
      expect(accepted).toEqual([]);
      expect((yield* send(JSON.stringify({ type: "user.deleted", data: {} }))).status).toBe(400);
      expect((yield* send(raw)).status).toBe(204);
      expect((yield* send(raw)).status).toBe(204);
      expect(accepted).toEqual(["fixture-a", "fixture-a"]);
      expect(
        (yield* send(JSON.stringify({ type: "user.created", data: { id: "fixture-b" } }))).status,
      ).toBe(204);
      expect(accepted).toHaveLength(2);
    }),
);
