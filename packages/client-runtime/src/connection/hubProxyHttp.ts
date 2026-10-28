import { buildEnvironmentAuthHeaders } from "../state/environmentHttpAuth.ts";
import * as Option from "effect/Option";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { environmentEndpointUrl, hubProxyEndpointUrl } from "../environment/endpoint.ts";
import { executeEnvironmentHttpRequest } from "../rpc/http.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError,
  ConnectionAttemptSuperseded,
} from "./model.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import type { HubProxyAuthorization } from "./hubProxyAuthSource.ts";

const isConnectionBlockedError = Schema.is(ConnectionBlockedError);
const isConnectionTransientError = Schema.is(ConnectionTransientError);
const isSuperseded = Schema.is(ConnectionAttemptSuperseded);

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
  hubProxyEndpointUrl(httpBaseUrl, nodeId);

const nodeUnavailableResult = (body: unknown) => {
  const offline = hubProxyNodeUnavailable(body);
  return offline === undefined ? undefined : ({ _tag: "Offline", error: offline } as const);
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
        "Enable GOAT Connect device access in the hub’s Settings → Hub, then sign out of GOAT Connect and sign back in. Paired clients can pair again with goat pair --hub-proxy.",
    });
  return new ConnectionBlockedError({
    reason: "permission",
    detail:
      typeof fields["message"] === "string"
        ? fields["message"].slice(0, 300)
        : "The hub session does not permit access to this node.",
  });
};

export const requestHubProxyJson = Effect.fn("HubProxy.requestJson")(function* <A, E>(
  auth: HubProxyAuthorization,
  nodeId: string,
  route: string,
  decode: (input: unknown) => Effect.Effect<A, E>,
  method: "GET" | "POST" = "GET",
) {
  return yield* Effect.gen(function* () {
    let selected = auth.current === undefined ? auth : yield* auth.current();
    let rejected = false;
    for (;;) {
      const actualUrl = environmentEndpointUrl(
        hubProxyEndpointUrl(selected.httpBaseUrl, nodeId),
        route,
      );
      const result = yield* executeEnvironmentHttpRequest(
        actualUrl,
        10_000,
        Effect.gen(function* () {
          const client = yield* HttpClient.HttpClient;
          const headers = yield* buildEnvironmentAuthHeaders(
            selected.authorization,
            method,
            actualUrl,
            Option.fromUndefinedOr(selected.signer),
          );
          const response = yield* client.execute(
            HttpClientRequest.make(method)(actualUrl, { headers: { ...headers } }),
          );
          if (
            response.status === 401 &&
            selected.authorization?._tag === "Dpop" &&
            auth.current !== undefined &&
            !rejected
          )
            return { _tag: "Renew", token: selected.authorization.accessToken } as const;
          // Returned, not failed: the request wrapper turns every failure into a transport error.
          if (response.status === 403)
            return {
              _tag: "Refused",
              body: yield* response.json.pipe(Effect.orElseSucceed((): unknown => null)),
            } as const;
          if (response.status === 503) {
            const unavailable = nodeUnavailableResult(
              yield* response.json.pipe(Effect.orElseSucceed((): unknown => null)),
            );
            if (unavailable !== undefined) return unavailable;
          }
          const ok = yield* HttpClientResponse.filterStatusOk(response);
          return { _tag: "Value", value: yield* decode(yield* ok.json) } as const;
        }),
      ).pipe((request) =>
        selected.authorization === null
          ? request.pipe(
              Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }),
            )
          : request,
      );
      if (result._tag === "Renew" && auth.current !== undefined) {
        selected = yield* auth.current(result.token);
        rejected = true;
        continue;
      }
      return result;
    }
  }).pipe(
    Effect.flatMap(
      (result): Effect.Effect<A, ConnectionBlockedError | ConnectionTransientError> => {
        switch (result._tag) {
          case "Refused":
            return Effect.fail(hubProxyRefusal(result.body));
          case "Offline":
            return Effect.fail(result.error);
          case "Value":
            return Effect.succeed(result.value);
          case "Renew":
            return Effect.fail(
              new ConnectionBlockedError({
                reason: "authentication",
                detail: "The hub rejected authorization.",
              }),
            );
        }
      },
    ),
    (request) =>
      auth.authorization === null
        ? request.pipe(
            Effect.provideService(FetchHttpClient.RequestInit, { credentials: "include" }),
          )
        : request,
    Effect.mapError((error) =>
      isConnectionBlockedError(error) || isConnectionTransientError(error) || isSuperseded(error)
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
});
