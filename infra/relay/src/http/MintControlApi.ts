import * as Effect from "effect/Effect";
import type * as Types from "effect/Types";
import * as HttpRouter from "effect/http/HttpRouter";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as RelayConfiguration from "../Config.ts";
import { isMintRequest } from "../auth/MintControl.ts";
import { currentTraceId } from "./ApiErrors.ts";

export const layer = HttpRouter.middleware(
  Effect.gen(function* () {
    const config = yield* RelayConfiguration.RelayConfiguration;
    const handle: (
      httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>,
    ) => Effect.Effect<
      HttpServerResponse.HttpServerResponse,
      Types.unhandled,
      HttpRouter.Provided
    > = Effect.fnUntraced(function* (
      httpEffect: Effect.Effect<HttpServerResponse.HttpServerResponse, Types.unhandled>,
    ) {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const path = (yield* HttpRouter.RouteContext).route.path;
      if (isMintRequest(request.method, path) && config.mintDisabled) {
        return HttpServerResponse.jsonUnsafe(
          {
            _tag: "RelayMintDisabledError",
            code: "relay_mint_disabled",
            traceId: yield* currentTraceId,
          },
          {
            status: 503,
            headers: { "cache-control": "no-store", "retry-after": "30" },
          },
        );
      }
      return yield* httpEffect;
    });
    return handle;
  }),
).layer;
