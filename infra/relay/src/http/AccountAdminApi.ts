// @effect-diagnostics nodeBuiltinImport:off -- Constant-time operator authentication uses Worker-compatible node:crypto, as APNs signing does.
import { createHash, timingSafeEqual } from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as AccountLifecycle from "../accounts/AccountLifecycle.ts";

export class AccountOperatorSecret extends Context.Service<
  AccountOperatorSecret,
  Redacted.Redacted<string>
>()("goat-relay/http/AccountAdminApi/AccountOperatorSecret") {}
export function operatorAuthenticated(
  header: string | undefined,
  secret: Redacted.Redacted<string>,
): boolean {
  if (!header || header.length > 4096 || !/^Bearer [^\s]+$/u.test(header)) return false;
  const digest = (value: string) => createHash("sha256").update(value).digest();
  return timingSafeEqual(digest(header.slice(7)), digest(Redacted.value(secret)));
}
const response = (body: unknown, status = 200) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: { "cache-control": "no-store" } });
const EmptyBody = Schema.Record(Schema.String, Schema.Never);
export const layer = Layer.unwrap(
  Effect.gen(function* () {
    const lifecycle = yield* AccountLifecycle.AccountLifecycle;
    const secret = yield* AccountOperatorSecret;
    const handler = Effect.fn("relay.admin.account_access")(
      function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const url = new URL(request.originalUrl, "https://relay.invalid");
        if (
          url.protocol !== "https:" ||
          !operatorAuthenticated(request.headers.authorization, secret)
        )
          return response({ code: "operator_unauthorized" }, 401);
        const account = /^\/internal\/admin\/accounts\/([^/]+)(?:\/(suspend|allow))?$/u.exec(
          url.pathname,
        );
        const operation =
          /^\/internal\/admin\/account-operations\/([0-9a-f-]{36})(?:\/(resume))?$/u.exec(
            url.pathname,
          );
        if (account?.[1]) {
          const userId = decodeURIComponent(account[1]);
          if (!userId || userId.length > 255) return response({ code: "invalid_request" }, 400);
          if (request.method === "GET" && !account[2])
            return response(yield* lifecycle.getAccount(userId));
          if (request.method === "POST" && (account[2] === "suspend" || account[2] === "allow")) {
            const key = request.headers["idempotency-key"];
            if (!key || !/^[A-Za-z0-9_-]{1,255}$/u.test(key))
              return response({ code: "invalid_idempotency_key" }, 400);
            const body = yield* request.text.pipe(Effect.orElseSucceed(() => "invalid"));
            if (
              body.length > 1024 ||
              Schema.decodeOption(Schema.fromJsonString(EmptyBody), { onExcessProperty: "error" })(
                body,
              )._tag !== "Some"
            )
              return response({ code: "invalid_request" }, 400);
            const result = yield* lifecycle.request({
              userId,
              kind: account[2],
              idempotencyKey: key,
            });
            return response(result, result.state === "completed" ? 200 : 202);
          }
        }
        if (operation?.[1]) {
          if (request.method === "GET" && !operation[2])
            return response(yield* lifecycle.getOperation(operation[1]));
          if (request.method === "POST" && operation[2] === "resume") {
            const result = yield* lifecycle.resume(operation[1]);
            return response(result, result.state === "completed" ? 200 : 202);
          }
        }
        return response({ code: "not_found" }, 404);
      },
      Effect.catchTags({
        AccountLifecycleConflict: (error) => Effect.succeed(response({ code: error.code }, 409)),
        RelayAuthorizationUnavailableError: () =>
          Effect.succeed(response({ code: "authorization_unavailable" }, 503)),
      }),
    );
    return HttpRouter.add("*", "/internal/admin/*", handler);
  }),
);
