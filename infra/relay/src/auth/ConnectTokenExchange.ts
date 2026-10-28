import { RelayConnectUpgradeRequiredError } from "@goat/contracts/connectAssurance";
import {
  RelayAccessTokenType,
  RelayAuthInvalidError,
  RelayInternalError,
  type RelayDpopAccessTokenRequest,
  type RelayDpopAccessTokenResponse,
} from "@goat/contracts/relay";
import { encodeOAuthScope } from "@goat/shared/oauthScope";
import { normalizeRelayIssuer } from "@goat/shared/relayJwt";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as AccountAccess from "../accounts/AccountAccess.ts";
import type * as RelayRateLimits from "../accounts/RelayRateLimits.ts";
import * as RelayConfiguration from "../Config.ts";
import * as ClientKeys from "./ClientKeys.ts";
import * as ConnectAuthentication from "./ConnectAuthentication.ts";
import * as RelayTokens from "./RelayTokens.ts";

type ExchangeError =
  | import("@goat/contracts/connectAssurance").RelayAuthenticationStrengthError
  | import("@goat/contracts/connectAssurance").RelayAuthenticationUnavailableError
  | RelayConnectUpgradeRequiredError
  | AccountAccess.AccountAccessError
  | RelayRateLimits.RateLimitError
  | RelayAuthInvalidError
  | RelayInternalError;
export class ConnectTokenExchange extends Context.Service<
  ConnectTokenExchange,
  {
    readonly exchange: (
      request: RelayDpopAccessTokenRequest,
      proofKeyThumbprint: string,
    ) => Effect.Effect<RelayDpopAccessTokenResponse, ExchangeError>;
  }
>()("goat-relay/auth/ConnectTokenExchange") {}

const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const crypto = yield* Crypto.Crypto;
  const tokens = yield* RelayTokens.RelayTokens;
  const auth = yield* ConnectAuthentication.ConnectAuthentication;
  const keys = yield* ClientKeys.ClientKeys;
  const access = yield* AccountAccess.AccountAccess;
  const unavailable = () =>
    new RelayInternalError({
      code: "internal_error",
      reason: "internal_error",
      traceId: "connect-exchange",
    });
  const exchange = Effect.fn("ConnectTokenExchange.exchange")(function* (
    request: RelayDpopAccessTokenRequest,
    proofKeyThumbprint: string,
  ) {
    if (request.connectAuthPolicyVersion !== 1)
      return yield* new RelayConnectUpgradeRequiredError({
        code: "connect_upgrade_required",
        requiredPolicyVersion: 1,
        traceId: "connect-exchange",
      });
    const scopes = tokens.resolveDpopAccessTokenScopes({
      clientId: request.client_id,
      scope: request.scope,
    });
    if (
      request.resource !== normalizeRelayIssuer(config.relayIssuer) ||
      !scopes ||
      !proofKeyThumbprint
    )
      return yield* new RelayAuthInvalidError({
        code: "auth_invalid",
        reason: "not_authorized",
        traceId: "connect-exchange",
      });
    const assurance = yield* auth.session(request.subject_token);
    // Invite and suspension denials surface as 403 before client-key admission records anything.
    yield* access.capture(assurance.userId);
    const now = yield* DateTime.now;
    const issuedAtEpochSeconds = Math.floor(now.epochMilliseconds / 1000);
    const admission = yield* keys.admit({
      assurance,
      clientId: request.client_id,
      thumbprint: proofKeyThumbprint,
      now: issuedAtEpochSeconds,
      ...(request.readmitClientKey ? { readmit: true } : {}),
    });
    const expires = DateTime.addDuration(now, RelayTokens.RELAY_DPOP_ACCESS_TOKEN_TTL);
    const token = yield* tokens
      .issueDpopAccessToken({
        userId: assurance.userId,
        assurance,
        clientKeyAuthorizedAt: admission.authorizedAt,
        clientKeyAdmissionId: admission.admissionId,
        proofKeyThumbprint,
        clientId: request.client_id,
        scopes,
        jti: yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable)),
        issuedAtEpochSeconds,
        expiresAtEpochSeconds: Math.floor(expires.epochMilliseconds / 1000),
      })
      .pipe(Effect.catchTags({ RelayJwtError: () => Effect.fail(unavailable()) }));
    return {
      access_token: token,
      issued_token_type: RelayAccessTokenType,
      token_type: "DPoP" as const,
      expires_in: Duration.toSeconds(RelayTokens.RELAY_DPOP_ACCESS_TOKEN_TTL),
      scope: encodeOAuthScope(scopes),
    };
  });
  return ConnectTokenExchange.of({ exchange });
});
export const layer = Layer.effect(ConnectTokenExchange, make);
