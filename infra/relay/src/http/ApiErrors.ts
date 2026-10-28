import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Record from "effect/Record";
import * as HttpEffect from "effect/http/HttpEffect";
import * as HttpServerResponse from "effect/http/HttpServerResponse";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as HttpApiError from "effect/http-api/HttpApiError";
import {
  RelayAccountPolicyErrors,
  RelayAuthInvalidError,
  RelayInternalError,
  RelayAuthorizationUnavailableError,
  type RelayAuthInvalidReason,
  type RelayDpopFailureReason,
} from "@goat/contracts/relay";
import * as Devices from "../agentActivity/Devices.ts";
import * as LiveActivities from "../agentActivity/LiveActivities.ts";
import * as EnvironmentLinks from "../environments/EnvironmentLinks.ts";
import * as ManagedEndpointAllocations from "../environments/ManagedEndpointAllocations.ts";
import * as EnvironmentCredentials from "../environments/EnvironmentCredentials.ts";
import * as DpopProofs from "../auth/DpopProofs.ts";
import * as AgentActivityRows from "../agentActivity/AgentActivityRows.ts";
import * as DeliveryAttempts from "../agentActivity/DeliveryAttempts.ts";
import * as HookInbox from "../hooks/HookInbox.ts";
import * as ManagedTunnelLimits from "../environments/ManagedTunnelLimits.ts";

export const appendRelayCredentialResponseHeaders = HttpEffect.appendPreResponseHandler(
  (_request, response) =>
    Effect.succeed(
      HttpServerResponse.setHeaders(response, {
        "cache-control": "no-store",
        pragma: "no-cache",
      }),
    ),
);

// GOAT hosts never retry sooner than Retry-After, so during a Cloudflare
// rate limit they wait out the pause instead of retrying into it.
const PolicyError = Schema.Union(RelayAccountPolicyErrors);
export const isPolicyError = Schema.is(PolicyError);
const decodePolicyError = Schema.decodeEffect(PolicyError);
export const appendPolicyHeaders = Effect.fn("relay.api.policy_headers")(function* (
  error: unknown,
) {
  if (!isPolicyError(error)) return;
  yield* appendRelayCredentialResponseHeaders;
  if (error._tag === "RelayRateLimitExceededError")
    yield* HttpEffect.appendPreResponseHandler((_request, response) =>
      Effect.succeed(
        HttpServerResponse.setHeader(response, "retry-after", String(error.retryAfterSeconds)),
      ),
    );
});

const isHttpUnauthorized = Schema.is(HttpApiError.Unauthorized);
const isDpopProofRejected = Schema.is(DpopProofs.DpopProofRejected);

export const currentTraceId = Effect.currentParentSpan.pipe(
  Effect.map((span) => span.traceId),
  Effect.orElseSucceed(() => "unavailable"),
);

export const policyErrorWithTrace = Effect.fn("relay.api.policy_error")(function* (
  error: typeof PolicyError.Type,
) {
  yield* appendPolicyHeaders(error);
  const traceId = yield* currentTraceId;
  return yield* decodePolicyError({ ...error, traceId }).pipe(Effect.orDie);
});
export const rethrowPolicyError = Effect.fn("relay.api.rethrow_policy_error")(
  (error: typeof PolicyError.Type) => policyErrorWithTrace(error).pipe(Effect.flatMap(Effect.fail)),
);

const RelayCommonPersistenceError = Schema.Union([
  Devices.DeviceRegistrationPersistenceError,
  Devices.DeviceUnregistrationPersistenceError,
  Devices.DeviceListPersistenceError,
  LiveActivities.LiveActivityRegistrationPersistenceError,
  EnvironmentLinks.EnvironmentLinkUserListPersistenceError,
  EnvironmentLinks.EnvironmentLinkListPersistenceError,
  EnvironmentLinks.EnvironmentLinkLookupPersistenceError,
  EnvironmentLinks.EnvironmentLinkRevokePersistenceError,
  ManagedEndpointAllocations.ManagedEndpointAllocationPersistenceError,
  EnvironmentCredentials.EnvironmentCredentialAuthenticatePersistenceError,
  EnvironmentCredentials.EnvironmentCredentialRevokePersistenceError,
  DpopProofs.DpopProofReplayPersistenceError,
  LiveActivities.LiveActivityTargetListPersistenceError,
  AgentActivityRows.AgentActivityRowUpsertPersistenceError,
  AgentActivityRows.AgentActivityRowDeletePersistenceError,
  AgentActivityRows.AgentActivityRowListPersistenceError,
  LiveActivities.LiveActivityDeliveryMarkPersistenceError,
  DeliveryAttempts.DeliveryAttemptRecordPersistenceError,
  EnvironmentLinks.EnvironmentLinkEnvironmentLookupPersistenceError,
  HookInbox.HookInboxError,
  ManagedTunnelLimits.ManagedTunnelLimitPersistenceError,
]);
type RelayCommonPersistenceError = typeof RelayCommonPersistenceError.Type;
const isRelayCommonPersistenceError = Schema.is(RelayCommonPersistenceError);

type MapRelayCommonApiError<E> =
  | Exclude<
      E,
      HttpApiError.Unauthorized | DpopProofs.DpopProofRejected | RelayCommonPersistenceError
    >
  | (Extract<E, HttpApiError.Unauthorized> extends never ? never : RelayAuthInvalidError)
  | (Extract<E, DpopProofs.DpopProofRejected> extends never ? never : RelayAuthInvalidError)
  | (Extract<E, RelayCommonPersistenceError> extends never
      ? never
      : RelayAuthorizationUnavailableError);

export function relayDpopFailureReason(
  code: DpopProofs.DpopProofFailureCode,
): RelayDpopFailureReason {
  switch (code) {
    case "time_window":
      return "time_window";
    case "key_mismatch":
      return "key_mismatch";
    case "method_mismatch":
    case "url_mismatch":
      return "request_mismatch";
    case "access_token_hash_mismatch":
      return "token_mismatch";
    case "replayed":
      return "replay";
    case "missing_proof":
    case "malformed_proof":
    case "invalid_signature":
    case "invalid_proof":
      return "invalid_proof";
  }
}

export function relayInternalErrorResponse(reason: RelayInternalError["reason"]) {
  return currentTraceId.pipe(
    Effect.flatMap((traceId) =>
      Effect.fail(new RelayInternalError({ code: "internal_error", reason, traceId })),
    ),
  );
}

export function mapRelayCommonApiErrors(authReason: RelayAuthInvalidReason) {
  const mapError = Effect.fnUntraced(function* <E>(error: E) {
    const traceId = yield* currentTraceId;
    if (isPolicyError(error))
      return yield* Effect.fail((yield* policyErrorWithTrace(error)) as MapRelayCommonApiError<E>);
    if (isDpopProofRejected(error)) {
      yield* Effect.annotateCurrentSpan({
        "relay.dpop.failure_code": error.code,
      });
      return yield* Effect.fail(
        new RelayAuthInvalidError({
          code: "auth_invalid",
          reason: authReason,
          ...(authReason === "invalid_dpop"
            ? { dpopFailureReason: relayDpopFailureReason(error.code) }
            : {}),
          traceId,
        }) as MapRelayCommonApiError<E>,
      );
    }
    if (isHttpUnauthorized(error)) {
      if (authReason === "invalid_dpop") {
        yield* Effect.annotateCurrentSpan({
          "relay.dpop.failure_code": "invalid_proof",
        });
      }
      return yield* Effect.fail(
        new RelayAuthInvalidError({
          code: "auth_invalid",
          reason: authReason,
          ...(authReason === "invalid_dpop" ? { dpopFailureReason: "invalid_proof" } : {}),
          traceId,
        }) as MapRelayCommonApiError<E>,
      );
    }
    if (isRelayCommonPersistenceError(error)) {
      return yield* Effect.fail(
        new RelayAuthorizationUnavailableError({
          code: "authorization_unavailable",
          traceId,
        }) as MapRelayCommonApiError<E>,
      );
    }

    return yield* Effect.fail(error as MapRelayCommonApiError<E>);
  });

  return <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, MapRelayCommonApiError<E>, R | HttpServerRequest.HttpServerRequest> =>
    effect.pipe(Effect.catch(mapError));
}

type TaggedErrorTag<E> = Extract<E, { readonly _tag: string }>["_tag"];

type MapErrorTagCases<E> = {
  readonly [K in TaggedErrorTag<E>]+?: (
    error: Extract<E, { readonly _tag: K }>,
    traceId: string,
  ) => unknown;
};

type MappedTagError<Cases> = Cases[keyof Cases] extends (
  ...args: ReadonlyArray<never>
) => infer Error
  ? Error
  : never;

type CatchTagCases<E, Cases> = {
  readonly [K in TaggedErrorTag<E>]+?: (
    error: Extract<E, { readonly _tag: K }>,
  ) => Effect.Effect<never, MappedTagError<Cases>>;
} & (unknown extends E ? {} : { readonly [K in Exclude<keyof Cases, TaggedErrorTag<E>>]: never });

export function mapErrorTags<
  E,
  Cases extends MapErrorTagCases<E> &
    (unknown extends E ? {} : { readonly [K in Exclude<keyof Cases, TaggedErrorTag<E>>]: never }),
>(cases: Cases) {
  const catchCases = Record.map(
    cases as Record.ReadonlyRecord<
      string,
      (error: never, traceId: string) => MappedTagError<Cases>
    >,
    (makeError) => (error: never) =>
      currentTraceId.pipe(Effect.flatMap((traceId) => Effect.fail(makeError(error, traceId)))),
  ) as CatchTagCases<E, Cases>;

  return <A, R>(
    self: Effect.Effect<A, E, R>,
  ): Effect.Effect<A, Exclude<E, { readonly _tag: keyof Cases }> | MappedTagError<Cases>, R> =>
    // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off
    Effect.catchTags(self, catchCases) as Effect.Effect<
      A,
      Exclude<E, { readonly _tag: keyof Cases }> | MappedTagError<Cases>,
      R
    >;
}
