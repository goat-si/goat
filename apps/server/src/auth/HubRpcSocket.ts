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
import { failEnvironmentAuthInvalid, failEnvironmentInternal } from "./http.ts";

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
      const url = HttpServerRequest.toURL(request);
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
      return yield* Lifetime.run(session, rpc(session)).pipe(
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
