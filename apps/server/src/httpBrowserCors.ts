import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  HttpEffect,
  HttpMiddleware,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";
import * as ServerConfig from "./config.ts";
import {
  browserApiCorsAllowedHeaders,
  browserApiCorsAllowedMethods,
  DESKTOP_RENDERER_ORIGINS,
  MCP_HTTP_PATH,
} from "./httpCors.ts";

function withVaryOrigin(
  response: HttpServerResponse.HttpServerResponse,
): HttpServerResponse.HttpServerResponse {
  const existing = response.headers.vary;
  if (
    existing !== undefined &&
    existing.split(",").some((token) => token.trim().toLowerCase() === "origin")
  ) {
    return response;
  }
  return HttpServerResponse.setHeader(
    response,
    "vary",
    existing ? `${existing}, Origin` : "Origin",
  );
}

export const layerBrowserApiCors = Layer.unwrap(
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const devOrigin = config.devUrl?.origin;
    // Credentialed dev requests need explicit Vite/Electron origins; originless desktop/native
    // requests and packaged servers use the non-credentialed wildcard.
    const wildcardCors = HttpMiddleware.cors({
      allowedMethods: browserApiCorsAllowedMethods,
      allowedHeaders: browserApiCorsAllowedHeaders,
      maxAge: 600,
    });
    const devCors = devOrigin
      ? HttpMiddleware.cors({
          allowedOrigins: [devOrigin, ...DESKTOP_RENDERER_ORIGINS, ...config.devAllowedOrigins],
          credentials: true,
          allowedMethods: browserApiCorsAllowedMethods,
          allowedHeaders: browserApiCorsAllowedHeaders,
          maxAge: 600,
        })
      : undefined;
    return HttpRouter.middleware(
      (httpEffect) => {
        const withWildcardCors = wildcardCors(httpEffect);
        const withDevCors = devCors ? devCors(httpEffect) : undefined;
        return Effect.flatMap(HttpServerRequest.HttpServerRequest, (request) => {
          if (request.url.split("?", 1)[0] === MCP_HTTP_PATH) return httpEffect;
          if (!withDevCors) return withWildcardCors;
          if (request.headers.origin !== undefined) return withDevCors;
          if (request.method === "OPTIONS") {
            return Effect.map(withWildcardCors, withVaryOrigin);
          }
          return HttpEffect.appendPreResponseHandler((_request, response) =>
            Effect.succeed(withVaryOrigin(response)),
          ).pipe(Effect.andThen(withWildcardCors));
        });
      },
      { global: true },
    );
  }),
);
