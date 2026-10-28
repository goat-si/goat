import { AuthWebSocketTicketResult, type AuthClientPresentationMetadata } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import {
  appendClientConnectionParams,
  resolveRemoteDpopWebSocketConnectionUrl,
} from "../authorization/remote.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { mapRemoteEnvironmentError } from "./errors.ts";
import { ConnectionBlockedError } from "./model.ts";
import type { HubProxyAuthorization } from "./hubProxyAuthSource.ts";
import { hubProxyHttpBaseUrl, requestHubProxyJson } from "./hubProxyHttp.ts";

const decodeTicket = Schema.decodeUnknownEffect(Schema.toCodecJson(AuthWebSocketTicketResult));
const dpopSocket = Effect.fn("HubProxy.dpopSocket")(function* (
  auth: HubProxyAuthorization,
  nodeId: string,
  metadata: AuthClientPresentationMetadata,
) {
  if (auth.authorization?._tag !== "Dpop" || auth.signer === undefined)
    return yield* new ConnectionBlockedError({
      reason: "configuration",
      detail: "GOAT Connect socket authorization is unavailable.",
    });
  const signer = auth.signer;
  const httpBaseUrl = hubProxyHttpBaseUrl(auth.httpBaseUrl, nodeId);
  return yield* resolveRemoteDpopWebSocketConnectionUrl({
    httpBaseUrl,
    wsBaseUrl: httpBaseUrl.replace(/^http/u, "ws"),
    accessToken: auth.authorization.accessToken,
    allowUnboundFallback: false,
    clientMetadata: metadata,
    connectionMethod: "direct",
    createProof: (input) =>
      signer
        .createProof(input)
        .pipe(
          Effect.mapError(
            (cause) =>
              new ConnectionBlockedError({ reason: "authentication", detail: cause.message }),
          ),
        ),
  });
});

export const openHubProxySocket = Effect.fn("HubProxy.openSocket")(function* (
  initial: HubProxyAuthorization,
  nodeId: string,
  metadata: AuthClientPresentationMetadata,
) {
  let auth = initial.current === undefined ? initial : yield* initial.current();
  let socketUrl: string;
  if (auth.authorization?._tag === "Dpop") {
    const rejected = auth.authorization.accessToken;
    let result = yield* dpopSocket(auth, nodeId, metadata).pipe(Effect.result);
    if (
      Result.isFailure(result) &&
      initial.current !== undefined &&
      ((result.failure._tag === "EnvironmentAuthInvalidError" &&
        result.failure.reason === "invalid_credential") ||
        (result.failure._tag === "RemoteEnvironmentAuthUndeclaredStatusError" &&
          result.failure.status === 401))
    ) {
      auth = yield* initial.current(rejected);
      result = yield* dpopSocket(auth, nodeId, metadata).pipe(Effect.result);
    }
    if (Result.isFailure(result))
      return yield* result.failure._tag === "ConnectionBlockedError"
        ? result.failure
        : mapRemoteEnvironmentError(result.failure);
    socketUrl = result.success;
  } else {
    const base = hubProxyHttpBaseUrl(auth.httpBaseUrl, nodeId);
    const ticket = yield* requestHubProxyJson(
      auth,
      nodeId,
      "/api/auth/websocket-ticket",
      decodeTicket,
      "POST",
    );
    const socket = new URL(environmentEndpointUrl(base, "/ws"));
    socket.protocol = socket.protocol === "https:" ? "wss:" : "ws:";
    socket.searchParams.set("wsTicket", ticket.ticket);
    appendClientConnectionParams(socket, metadata, "direct");
    socketUrl = socket.toString();
  }
  return {
    httpBaseUrl: hubProxyHttpBaseUrl(auth.httpBaseUrl, nodeId),
    socketUrl,
    httpAuthorization: auth.authorization,
  };
});
