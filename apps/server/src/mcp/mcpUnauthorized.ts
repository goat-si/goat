import * as Option from "effect/Option";
import { HttpServerRequest, HttpServerResponse } from "effect/http";

export const GENERIC_REFUSAL = "A valid GOAT MCP credential is required.";

const mcpResourceMetadataUrl = (request: HttpServerRequest.HttpServerRequest) =>
  HttpServerRequest.toURL(request).pipe(
    Option.map((url) => `${url.origin}/.well-known/oauth-protected-resource/mcp`),
  );

/** Launched agents cannot open OAuth browsers; OAuth would mint credentials outliving their session. */
export const unauthorized = (input: {
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
