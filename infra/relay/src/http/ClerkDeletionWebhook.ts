import { verifyWebhook } from "@clerk/backend/webhooks";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import { AccountLifecycle } from "../accounts/AccountLifecycle.ts";
import { RelayConfiguration } from "../Config.ts";

export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const lifecycle = yield* AccountLifecycle;
    const config = yield* RelayConfiguration;
    return HttpRouter.add(
      "POST",
      "/v1/webhooks/clerk",
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const response = (status: number) =>
          HttpServerResponse.empty({ status, headers: { "cache-control": "no-store" } });
        if (!config.clerkWebhookSigningSecret) return response(503);
        const signingSecret = Redacted.value(config.clerkWebhookSigningSecret);
        const raw = yield* request.arrayBuffer.pipe(Effect.result);
        if (raw._tag === "Failure") return response(400);
        if (raw.success.byteLength > 1_048_576) return response(413);
        const event = yield* Effect.tryPromise({
          try: () =>
            verifyWebhook(
              new Request(new URL(request.originalUrl, config.relayIssuer), {
                method: "POST",
                headers: request.headers,
                body: raw.success,
              }),
              { signingSecret: signingSecret },
            ),
          catch: () => "signature_invalid" as const,
        }).pipe(Effect.result);
        if (event._tag === "Failure") return response(400);
        if (event.success.type !== "user.deleted") return response(204);
        const subject = event.success.data.id;
        if (!subject?.trim()) return response(400);
        const accepted = yield* lifecycle
          .requestDelete({
            userId: subject,
            idempotencyKey: "clerk:user.deleted",
            identityDeleted: true,
          })
          .pipe(Effect.result);
        return response(accepted._tag === "Success" ? 204 : 503);
      }),
    );
  }),
);
