import * as HostProcess from "@goat/shared/HostProcess";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- WebSocket negotiation uses the original Node upgrade request.
import * as NodeHttp from "node:http";
import * as ServerConfig from "../config.ts";
import { DESKTOP_RENDERER_ORIGINS } from "../httpCors.ts";
import { isLoopbackHost, isPrivateNetworkAddress } from "../startupAccess.ts";
import { DESKTOP_BOOTSTRAP_SUBJECT } from "./PairingGrantStore.ts";
import {
  type EnvironmentAuthInvalidError,
  type EnvironmentInternalError,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  servesOrchestrationProtocol,
} from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import {
  HttpRouter,
  HttpServerRequest,
  HttpServerRespondable,
  HttpServerResponse,
} from "effect/http";
import * as EnvironmentAuth from "./EnvironmentAuth.ts";
import * as Lifetime from "./SessionSocketLifetime.ts";

export { layerFor as rpcAuthorization } from "./proxiedCallPolicy.ts";
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "./http.ts";
import { requestUrl } from "../requestUrl.ts";

const proxyHeaders = [
  "forwarded",
  "via",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-real-ip",
];

const omitLocalDesktopCompression = Effect.fn("HubRpcSocket.omitLocalDesktopCompression")(
  function* (
    request: HttpServerRequest.HttpServerRequest,
    session: EnvironmentAuth.AuthenticatedSession,
  ) {
    if (
      session.subject !== DESKTOP_BOOTSTRAP_SUBJECT ||
      !(request.source instanceof NodeHttp.IncomingMessage) ||
      !DESKTOP_RENDERER_ORIGINS.some((origin) => origin === request.headers.origin) ||
      proxyHeaders.some((header) => request.headers[header] !== undefined)
    )
      return;
    const config = yield* ServerConfig.ServerConfig;
    if (config.mode !== "desktop") return;
    const { localAddress, remoteAddress } = request.source.socket;
    if (localAddress === undefined || remoteAddress === undefined) return;
    const loopback = [localAddress, remoteAddress].every((address) =>
      isLoopbackHost(address.replace(/^::ffff:/iu, "")),
    );
    const platform = yield* HostProcess.Platform;
    const env = yield* HostProcess.Environment;
    // WSL NAT connects from the Windows host over private addresses instead of loopback.
    const wsl = platform === "linux" && (env.WSL_DISTRO_NAME || env.WSL_INTEROP);
    if (
      loopback ||
      (wsl && isPrivateNetworkAddress(localAddress) && isPrivateNetworkAddress(remoteAddress))
    ) {
      delete request.source.headers["sec-websocket-extensions"];
    }
  },
);

export const layer = <E, R>(
  rpc: (
    session: EnvironmentAuth.AuthenticatedSession,
  ) => Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>,
) =>
  HttpRouter.add(
    "GET",
    "/ws",
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      const url = requestUrl(request);
      if (
        Option.isNone(url) ||
        !servesOrchestrationProtocol(url.value.searchParams.get(ORCHESTRATION_PROTOCOL_QUERY_PARAM))
      ) {
        return HttpServerResponse.jsonUnsafe(
          {
            code: "orchestration_protocol_incompatible",
            message: `Update this client to one that supports orchestration protocol ${ORCHESTRATION_PROTOCOL_VERSION}.`,
            orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
          },
          { status: 426 },
        );
      }
      const auth = yield* EnvironmentAuth.EnvironmentAuth;
      const session = yield* auth.authenticateWebSocketUpgrade(request, "rpc").pipe(
        Effect.catchIf(EnvironmentAuth.isServerAuthCredentialError, (error) =>
          failEnvironmentAuthInvalid(
            EnvironmentAuth.serverAuthCredentialReason(error),
            EnvironmentAuth.serverAuthDpopFailureReason(error),
          ),
        ),
        Effect.catchIf(EnvironmentAuth.isServerAuthInternalError, (error) =>
          failEnvironmentInternal("internal_error", error),
        ),
      );
      return yield* Lifetime.run(
        session,
        Effect.andThen(omitLocalDesktopCompression(request, session), rpc(session)),
      ).pipe(
        Effect.catchIf(
          (error) => Predicate.isTagged(error, "SessionCredentialVerificationError"),
          (error) => failEnvironmentInternal("internal_error", error),
        ),
      );
    }).pipe(
      Effect.catchIf(
        (error: unknown): error is EnvironmentAuthInvalidError =>
          Predicate.isTagged(error, "EnvironmentAuthInvalidError"),
        (error) => HttpServerRespondable.toResponse(error),
      ),
      Effect.catchIf(
        (error: unknown): error is EnvironmentInternalError =>
          Predicate.isTagged(error, "EnvironmentInternalError"),
        (error) => HttpServerRespondable.toResponse(error),
      ),
    ),
  );
