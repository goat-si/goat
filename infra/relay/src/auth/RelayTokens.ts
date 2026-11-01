import { assertEnabled } from "./MintControl.ts";
import * as AccountAccess from "../accounts/AccountAccess.ts";
import * as RelayRateLimits from "../accounts/RelayRateLimits.ts";
import {
  ConnectSessionAssurance,
  ConnectLinkIntent,
  connectAssuranceFreshnessDeadline,
  isConnectAssuranceFresh,
} from "@goat/contracts/connectAssurance";
import {
  RelayDpopAccessTokenScope,
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
  RelayMobileClientId,
  RelayWebClientId,
  type RelayPublicClientId,
  type RelayEnvironmentLinkChallengeRequest,
} from "@goat/contracts/relay";
import { encodeOAuthScope, parseAllowedOAuthScope } from "@goat/shared/oauthScope";
import {
  normalizeRelayIssuer,
  RelayJwtError,
  signRelayJwt,
  verifyRelayJwt,
} from "@goat/shared/relayJwt";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";

import * as RelayConfiguration from "../Config.ts";

const LINK_CHALLENGE_TYP = "goat-link-challenge+jwt";
const ACCESS_TOKEN_TYP = "goat-relay-dpop-access+jwt";
const LINK_CHALLENGE_KIND = "environment_link_challenge";
export const RELAY_DPOP_ACCESS_TOKEN_TTL = "30 minutes";

const LinkChallengeClaims = Schema.Struct({
  kind: Schema.Literal(LINK_CHALLENGE_KIND),
  assurance: ConnectSessionAssurance,
  intent: ConnectLinkIntent,
  cliKeyThumbprint: Schema.optionalKey(Schema.String),
  iss: Schema.String,
  aud: Schema.String,
  sub: Schema.String,
  account_epoch: Schema.optionalKey(Schema.Int),
  jti: Schema.String,
  iat: Schema.Int,
  exp: Schema.Int,
  notificationsEnabled: Schema.Boolean,
  liveActivitiesEnabled: Schema.Boolean,
  managedTunnelsEnabled: Schema.Boolean,
});
export type LinkChallengeClaims = typeof LinkChallengeClaims.Type;

const RelayDpopAccessTokenClaims = Schema.Struct({
  assurance: ConnectSessionAssurance,
  clientKeyAuthorizedAt: Schema.Int,
  clientKeyAdmissionId: Schema.String,
  iss: Schema.String,
  aud: Schema.String,
  sub: Schema.String,
  account_epoch: Schema.optionalKey(Schema.Int),
  jti: Schema.String,
  iat: Schema.Int,
  exp: Schema.Int,
  client_id: Schema.Literals([RelayMobileClientId, RelayWebClientId]),
  scope: Schema.String,
  cnf: Schema.Struct({ jkt: Schema.String }),
});
export type RelayDpopAccessTokenClaims = Omit<typeof RelayDpopAccessTokenClaims.Type, "scope"> & {
  readonly scope: ReadonlyArray<RelayDpopAccessTokenScope>;
};

const decodeLinkChallengeClaims = Schema.decodeUnknownEffect(LinkChallengeClaims);
const decodeDpopAccessTokenClaims = Schema.decodeUnknownEffect(RelayDpopAccessTokenClaims);

const allowedScopesByClientId: Record<
  RelayPublicClientId,
  ReadonlySet<RelayDpopAccessTokenScope>
> = {
  [RelayMobileClientId]: new Set([RelayEnvironmentConnectScope, RelayEnvironmentStatusScope]),
  [RelayWebClientId]: new Set([RelayEnvironmentConnectScope, RelayEnvironmentStatusScope]),
};

function resolveDpopAccessTokenScopes(input: {
  readonly clientId: RelayPublicClientId;
  readonly scope: string;
}): ReadonlyArray<RelayDpopAccessTokenScope> | null {
  return parseAllowedOAuthScope({
    value: input.scope,
    allowedScopes: allowedScopesByClientId[input.clientId],
  });
}

export class RelayTokens extends Context.Service<
  RelayTokens,
  {
    readonly resolveDpopAccessTokenScopes: typeof resolveDpopAccessTokenScopes;
    readonly issueLinkChallenge: (input: {
      readonly userId: string;
      readonly request: RelayEnvironmentLinkChallengeRequest;
      readonly assurance: ConnectSessionAssurance;
      readonly cliKeyThumbprint?: string;
      readonly intent: ConnectLinkIntent;
      readonly jti: string;
      readonly issuedAtEpochSeconds: number;
      readonly expiresAtEpochSeconds: number;
    }) => Effect.Effect<
      string,
      RelayJwtError | AccountAccess.AccountAccessError | RelayRateLimits.RateLimitError
    >;
    readonly verifyLinkChallenge: (input: {
      readonly token: string;
      readonly userId: string;
      readonly request: RelayEnvironmentLinkChallengeRequest;
      readonly nowEpochSeconds: number;
    }) => Effect.Effect<LinkChallengeClaims | null>;
    readonly issueDpopAccessToken: (input: {
      readonly userId: string;
      readonly proofKeyThumbprint: string;
      readonly jti: string;
      readonly issuedAtEpochSeconds: number;
      readonly expiresAtEpochSeconds: number;
      readonly clientId: RelayPublicClientId;
      readonly assurance: ConnectSessionAssurance;
      readonly clientKeyAuthorizedAt: number;
      readonly clientKeyAdmissionId: string;
      readonly scopes: ReadonlyArray<RelayDpopAccessTokenScope>;
    }) => Effect.Effect<
      string,
      RelayJwtError | AccountAccess.AccountAccessError | RelayRateLimits.RateLimitError
    >;
    readonly verifyDpopAccessToken: (input: {
      readonly token: string;
      readonly nowEpochSeconds: number;
    }) => Effect.Effect<RelayDpopAccessTokenClaims | null>;
  }
>()("goat-relay/auth/RelayTokens") {}

const make = Effect.gen(function* () {
  const access = yield* AccountAccess.AccountAccess;
  const rates = yield* RelayRateLimits.RelayRateLimits;
  const config = yield* RelayConfiguration.RelayConfiguration;
  const issuer = normalizeRelayIssuer(config.relayIssuer);

  const issueLinkChallenge: RelayTokens["Service"]["issueLinkChallenge"] = Effect.fn(
    "relay.tokens.issue_link_challenge",
  )(function* (input) {
    yield* assertEnabled(config);
    const admitted = yield* access.admit(input.userId);
    yield* rates.charge({ userId: input.userId, operation: "link_challenge" });
    yield* access.requireAllowed(admitted);
    return yield* signRelayJwt({
      privateKey: Redacted.value(config.cloudMintPrivateKey),
      typ: LINK_CHALLENGE_TYP,
      payload: {
        kind: LINK_CHALLENGE_KIND,
        iss: issuer,
        aud: issuer,
        sub: input.userId,
        account_epoch: admitted.accountEpoch,
        jti: input.jti,
        iat: input.issuedAtEpochSeconds,
        exp: Math.min(
          input.expiresAtEpochSeconds,
          connectAssuranceFreshnessDeadline(input.assurance),
        ),
        assurance: input.assurance,
        intent: input.intent,
        ...(input.cliKeyThumbprint ? { cliKeyThumbprint: input.cliKeyThumbprint } : {}),
        notificationsEnabled: false,
        liveActivitiesEnabled: false,
        managedTunnelsEnabled: input.request.managedTunnelsEnabled,
      },
    });
  });

  const verifyLinkChallenge: RelayTokens["Service"]["verifyLinkChallenge"] = Effect.fn(
    "relay.tokens.verify_link_challenge",
  )((input) =>
    verifyRelayJwt({
      publicKey: config.cloudMintPublicKey,
      token: input.token,
      typ: LINK_CHALLENGE_TYP,
      issuer,
      audience: issuer,
      nowEpochSeconds: input.nowEpochSeconds,
    }).pipe(
      Effect.flatMap(decodeLinkChallengeClaims),
      Effect.map((claims) => {
        if (
          claims.exp <= input.nowEpochSeconds ||
          claims.iat > input.nowEpochSeconds ||
          claims.sub !== input.userId ||
          claims.assurance.userId !== input.userId ||
          !isConnectAssuranceFresh(claims.assurance, input.nowEpochSeconds) ||
          (input.request.notificationsEnabled && claims.notificationsEnabled !== true) ||
          (input.request.liveActivitiesEnabled && claims.liveActivitiesEnabled !== true) ||
          (input.request.managedTunnelsEnabled && claims.managedTunnelsEnabled !== true)
        ) {
          return null;
        }
        return claims;
      }),
      Effect.orElseSucceed(() => null),
    ),
  );

  const issueDpopAccessToken: RelayTokens["Service"]["issueDpopAccessToken"] = Effect.fn(
    "relay.tokens.issue_dpop_access_token",
  )(function* (input) {
    yield* assertEnabled(config);
    const admitted = yield* access.admit(input.userId);
    yield* rates.charge({ userId: input.userId, operation: "dpop_token" });
    yield* access.requireAllowed(admitted);
    return yield* signRelayJwt({
      privateKey: Redacted.value(config.cloudMintPrivateKey),
      typ: ACCESS_TOKEN_TYP,
      payload: {
        iss: issuer,
        aud: issuer,
        sub: input.userId,
        account_epoch: admitted.accountEpoch,
        jti: input.jti,
        iat: input.issuedAtEpochSeconds,
        exp: input.expiresAtEpochSeconds,
        assurance: input.assurance,
        clientKeyAuthorizedAt: input.clientKeyAuthorizedAt,
        clientKeyAdmissionId: input.clientKeyAdmissionId,
        client_id: input.clientId,
        scope: encodeOAuthScope(input.scopes),
        cnf: { jkt: input.proofKeyThumbprint },
      },
    });
  });

  const verifyDpopAccessToken: RelayTokens["Service"]["verifyDpopAccessToken"] = Effect.fn(
    "relay.tokens.verify_dpop_access_token",
  )((input) =>
    verifyRelayJwt({
      publicKey: config.cloudMintPublicKey,
      token: input.token,
      typ: ACCESS_TOKEN_TYP,
      issuer,
      audience: issuer,
      nowEpochSeconds: input.nowEpochSeconds,
      maxTokenAge: RELAY_DPOP_ACCESS_TOKEN_TTL,
    }).pipe(
      Effect.tapError((error) =>
        Effect.annotateCurrentSpan(
          "relay.tokens.verification_failure",
          RelayJwtError.diagnosticCode(error),
        ),
      ),
      Effect.flatMap(decodeDpopAccessTokenClaims),
      Effect.map((claims): RelayDpopAccessTokenClaims | null => {
        const scopes = resolveDpopAccessTokenScopes({
          clientId: claims.client_id,
          scope: claims.scope,
        });
        return scopes === null ||
          claims.assurance.userId !== claims.sub ||
          claims.assurance.checkedAt > input.nowEpochSeconds
          ? null
          : { ...claims, scope: scopes };
      }),
      Effect.orElseSucceed(() => null),
    ),
  );

  return RelayTokens.of({
    resolveDpopAccessTokenScopes,
    issueLinkChallenge,
    verifyLinkChallenge,
    issueDpopAccessToken,
    verifyDpopAccessToken,
  });
});

export const layer = Layer.effect(RelayTokens, make);
