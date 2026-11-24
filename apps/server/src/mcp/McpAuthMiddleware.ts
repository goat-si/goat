import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import { McpProtocol } from "effect/ai";
import type * as Types from "effect/Types";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import { connectionOf } from "../auth/connectionContext.ts";
import { isBrowserOriginAllowed } from "../auth/browserOrigin.ts";
import * as ServerConfig from "../config.ts";
import { DESKTOP_RENDERER_ORIGINS } from "../httpCors.ts";
import { parseBearerToken } from "../auth/EnvironmentAuth.ts";
import * as Profiles from "../goatclaw/PermissionProfiles.ts";
import { requestUrl } from "../requestUrl.ts";
import * as Settings from "../serverSettings.ts";
import { credentialRefusalMessage, GENERIC_REFUSAL, refusedToolCallId } from "./mcpAuthResponse.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import { normalizeMcpHttpResponse } from "./normalizeMcpHttpResponse.ts";
import { withServedToolNames } from "./ToolDispatch.ts";
import { listingSetting, withCallerListing } from "./toolListing.ts";

// Effect rejects unknown stateless notifications without metadata; Go MCP clients send roots changes.
const isUndefinedNotification = Effect.fnUntraced(function* (
  request: HttpServerRequest.HttpServerRequest,
) {
  const method = request.headers["mcp-method"];
  const protocol = [McpProtocol.v2025_06_18, McpProtocol.v2026_07_28].find(
    (candidate) => candidate.protocolVersion === request.headers["mcp-protocol-version"],
  );
  if (
    request.method !== "POST" ||
    protocol?.runtime._tag !== "Stateless" ||
    !method?.startsWith("notifications/") ||
    protocol.clientRpcs.requests.has(method)
  )
    return false;
  const message = yield* Effect.orElseSucceed(request.json, () => undefined);
  return (
    Predicate.isReadonlyObject(message) &&
    message.jsonrpc === "2.0" &&
    message.method === method &&
    !Predicate.hasProperty(message, "id")
  );
});

const mcpResourceMetadataUrl = (request: HttpServerRequest.HttpServerRequest) =>
  requestUrl(request).pipe(
    Option.map((url) => `${url.origin}/.well-known/oauth-protected-resource/mcp`),
  );

/** Launched agents cannot open OAuth browsers; OAuth would mint credentials outliving their session. */
const unauthorized = (input: {
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly presentedToken: boolean;
  readonly offerOAuth: boolean;
  readonly message?: string;
}) => {
  const metadataUrl = input.offerOAuth
    ? Option.getOrUndefined(mcpResourceMetadataUrl(input.request))
    : undefined;
  const challenge = [
    "Bearer",
    [
      ...(metadataUrl === undefined ? [] : [`resource_metadata="${metadataUrl}"`]),
      ...(input.presentedToken ? ['error="invalid_token"'] : []),
    ].join(", "),
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  return HttpServerResponse.jsonUnsafe(
    {
      error: "invalid_mcp_credential",
      message: input.message ?? GENERIC_REFUSAL,
    },
    {
      status: 401,
      headers: {
        "cache-control": "no-store",
        "www-authenticate": challenge,
      },
    },
  );
};

export class McpClientAuthenticator extends Context.Service<
  McpClientAuthenticator,
  {
    readonly authenticate: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  }
>()("goat/mcp/McpAuthMiddleware/McpClientAuthenticator") {}

type AuthenticatedHttpEffect = Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  McpInvocationContext.McpInvocationContext
>;

type McpAuthMiddleware = (
  httpEffect: AuthenticatedHttpEffect,
) => Effect.Effect<
  HttpServerResponse.HttpServerResponse,
  Types.unhandled,
  HttpServerRequest.HttpServerRequest
>;

// Session tokens are `<payload>.<signature>`; registry tokens are a bare base64url secret.
const looksLikeProviderToken = (token: string) => token.length > 0 && !token.includes(".");

export const makeMcpAuthMiddleware = Effect.gen(function* () {
  const registry = yield* McpSessionRegistry.McpSessionRegistry;
  const clients = yield* Effect.serviceOption(McpClientAuthenticator);
  const listing = listingSetting(yield* Effect.serviceOption(Settings.ServerSettingsService));
  const permissions = yield* Effect.serviceOption(Profiles.PermissionProfiles);
  const config = yield* Effect.serviceOption(ServerConfig.ServerConfig);
  const trustedOrigins = new Set<string>([
    ...DESKTOP_RENDERER_ORIGINS,
    ...(Option.isSome(config) && config.value.devUrl ? [config.value.devUrl.origin] : []),
    ...(Option.isSome(config) ? config.value.devAllowedOrigins : []),
  ]);
  const authenticateRequest = Effect.fn("McpHttpServer.authenticateRequest")(function* (
    request: HttpServerRequest.HttpServerRequest,
  ) {
    const token = parseBearerToken(request) ?? "";
    // A thread credential is not a stored session; it never resolves on a Pen connection (§6).
    const onPen = connectionOf(request)?.kind === "pen";
    const invocation =
      (onPen ? undefined : yield* registry.resolve(token)) ??
      (Option.isSome(clients) && token.length > 0
        ? yield* clients.value.authenticate(request)
        : undefined);
    if (!invocation) {
      const refusal: McpSessionRegistry.McpCredentialRefusal = registry.explainRefusal
        ? yield* registry.explainRefusal(token)
        : { reason: token.length === 0 ? "missing" : "unknown" };
      const registryToken = registry.isRegistryToken?.(token) === true;
      const toolCallId = registryToken ? yield* refusedToolCallId(request) : undefined;
      const details = {
        reason: refusal.reason,
        ...(refusal.threadId === undefined ? {} : { threadId: refusal.threadId }),
        ...(refusal.providerSessionId === undefined
          ? {}
          : { providerSessionId: refusal.providerSessionId }),
        ...(refusal.providerInstanceId === undefined
          ? {}
          : { providerInstanceId: refusal.providerInstanceId }),
        ...(refusal.endedAt === undefined ? {} : { endedAt: refusal.endedAt }),
        registryToken,
        toolCall: toolCallId !== undefined,
      };
      yield* Effect.logWarning(
        "refused an MCP request whose credential does not resolve",
        details,
      ).pipe(
        Effect.withSpan("McpHttpServer.refuseCredential", {
          attributes: Object.fromEntries(
            Object.entries(details).map(([key, value]) => [`mcp.credential.${key}`, value]),
          ),
        }),
      );
      const message = credentialRefusalMessage(refusal.reason);
      if (toolCallId !== undefined)
        return HttpServerResponse.jsonUnsafe(
          {
            jsonrpc: "2.0",
            id: toolCallId,
            result: { content: [{ type: "text", text: message }], isError: true },
          },
          { status: 200, headers: { "cache-control": "no-store" } },
        );
      return unauthorized({
        request,
        presentedToken: token.length > 0,
        offerOAuth: Option.isSome(clients) && !looksLikeProviderToken(token),
        message,
      });
    }
    return invocation;
  });
  // The HTTP span covers the downstream tool call.
  return Effect.fnUntraced(function* (httpEffect) {
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!isBrowserOriginAllowed(request, trustedOrigins))
      return HttpServerResponse.empty({ status: 403 });
    const origin = request.headers.origin;
    const cors = (response: HttpServerResponse.HttpServerResponse) =>
      origin === undefined
        ? response
        : HttpServerResponse.setHeaders(response, {
            "access-control-allow-origin": origin,
            "access-control-allow-credentials": "true",
            "access-control-allow-methods": "GET, POST, DELETE, OPTIONS",
            "access-control-allow-headers":
              "authorization, content-type, mcp-session-id, mcp-protocol-version, last-event-id",
            "access-control-expose-headers": "mcp-session-id, mcp-protocol-version",
            vary: "Origin",
          });
    if (origin !== undefined && request.method === "OPTIONS")
      return cors(HttpServerResponse.empty({ status: 204 }));
    const invocation = yield* authenticateRequest(request);
    if (HttpServerResponse.isHttpServerResponse(invocation)) return cors(invocation);
    if (yield* isUndefinedNotification(request))
      return cors(HttpServerResponse.empty({ status: 202 }));
    return yield* withCallerListing(
      listing,
      permissions,
    )(withServedToolNames(httpEffect)).pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.map(normalizeMcpHttpResponse),
      Effect.map(cors),
    );
  }) satisfies McpAuthMiddleware;
}).pipe(Effect.withSpan("McpHttpServer.makeAuthMiddleware"));

export const layerMcpAuthMiddleware = HttpRouter.middleware<{
  provides: McpInvocationContext.McpInvocationContext;
}>()(makeMcpAuthMiddleware).layer;
