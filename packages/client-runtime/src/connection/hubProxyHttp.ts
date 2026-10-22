import { hubProxyNodePath } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { executeEnvironmentHttpRequest } from "../rpc/http.ts";
import { ConnectionBlockedError, ConnectionTransientError } from "./model.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import type { HubProxyAuthorization } from "./hubProxyAuthSource.ts";

const isConnectionBlockedError = Schema.is(ConnectionBlockedError);
const isConnectionTransientError = Schema.is(ConnectionTransientError);

/**
 * The hub is up but cannot reach the node: asleep, off, or its SSH or runtime failing. That is the
 * quiet unreachable-host state, retried on the normal backoff while the cached threads stay shown.
 */
export const hubProxyNodeUnavailable = (body: unknown): ConnectionTransientError | undefined => {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (fields["code"] !== "hub_node_unavailable") return undefined;
  return new ConnectionTransientError({
    reason: "host-unreachable",
    detail:
      typeof fields["message"] === "string" && fields["message"].length > 0
        ? `The hub cannot reach this machine: ${fields["message"].slice(0, 200)}`
        : "The hub cannot reach this machine.",
  });
};

export const hubProxyHttpBaseUrl = (httpBaseUrl: string, nodeId: string): string =>
  environmentEndpointUrl(httpBaseUrl, `${hubProxyNodePath(nodeId)}/`);

const nodeUnavailableResult = (body: unknown) => {
  const offline = hubProxyNodeUnavailable(body);
  return offline === undefined ? undefined : ({ offline } as const);
};

/**
 * A 403 under a node path says which grant is missing: the hub's access to that node, or this
 * device's hub:proxy. Each needs a different fix, so the reason must survive status filtering.
 */
export const hubProxyRefusal = (body: unknown): ConnectionBlockedError => {
  const fields = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  if (fields["code"] === "hub_node_enrollment_required")
    return new ConnectionBlockedError({
      reason: "permission",
      detail:
        "The hub's access to this machine ended. Allow phone access again on the hub, under Settings → Connections.",
    });
  if (fields["requiredScope"] === "hub:proxy")
    return new ConnectionBlockedError({
      reason: "permission",
      detail:
        "This device was paired without hub access. Pair it again with goat pair --hub-proxy on the hub.",
    });
  return new ConnectionBlockedError({
    reason: "permission",
    detail:
      typeof fields["message"] === "string"
        ? fields["message"].slice(0, 300)
        : "The hub session does not permit access to this node.",
  });
};

export const requestHubProxyJson = <A, E>(
  auth: HubProxyAuthorization,
  requestUrl: string,
  decode: (input: unknown) => Effect.Effect<A, E>,
  method: "GET" | "POST" = "GET",
) =>
  executeEnvironmentHttpRequest(
    requestUrl,
    10_000,
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const headers =
        auth.authorization?._tag === "Bearer"
          ? { authorization: `Bearer ${auth.authorization.token}` }
          : {};
      const response = yield* client.execute(
        HttpClientRequest.make(method)(requestUrl, { headers }),
      );
      // Returned, not failed: the request wrapper turns every failure into a transport error.
      if (response.status === 403)
        return {
          refused: yield* response.json.pipe(Effect.orElseSucceed((): unknown => null)),
        } as const;
      if (response.status === 503) {
        const unavailable = nodeUnavailableResult(
          yield* response.json.pipe(Effect.orElseSucceed((): unknown => null)),
        );
        if (unavailable !== undefined) return unavailable;
      }
      const ok = yield* HttpClientResponse.filterStatusOk(response);
      return { value: yield* decode(yield* ok.json) } as const;
    }),
  ).pipe(
    Effect.flatMap((result): Effect.Effect<A, ConnectionBlockedError | ConnectionTransientError> =>
      "refused" in result
        ? Effect.fail(hubProxyRefusal(result.refused))
        : "offline" in result
          ? Effect.fail(result.offline)
          : Effect.succeed(result.value),
    ),
    (request) =>
      auth.authorization === null
        ? request.pipe(
            Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }),
          )
        : request,
    Effect.mapError((error) =>
      isConnectionBlockedError(error) || isConnectionTransientError(error)
        ? error
        : error._tag === "RemoteEnvironmentAuthUndeclaredStatusError" &&
            (error.status === 401 || error.status === 403)
          ? new ConnectionBlockedError({
              reason: error.status === 401 ? "authentication" : "permission",
              detail:
                error.status === 401
                  ? "The hub session is unavailable. Pair with the hub again."
                  : "The hub session does not permit access to this node.",
            })
          : mapRemoteEnvironmentError(error),
    ),
  );
