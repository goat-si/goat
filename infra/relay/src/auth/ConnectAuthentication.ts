import * as ConnectAccounts from "./ConnectAccounts.ts";
import { createClerkClient, verifyToken } from "@clerk/backend";
import {
  ConnectSessionAssurance,
  isConnectAssuranceFresh,
  RelayAuthenticationStrengthError,
  RelayAuthenticationUnavailableError,
} from "@goat/contracts/connectAssurance";
import { RelayAuthInvalidError, RelayInternalError } from "@goat/contracts/relay";
import { clerkFrontendApiUrlFromPublishableKey } from "@goat/shared/relayAuth";
import { CONNECT_OAUTH_SCOPES } from "@goat/shared/connectAuth";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as RelayConfiguration from "../Config.ts";

const SessionClaims = Schema.Struct({
  sub: Schema.String.check(Schema.isNonEmpty()),
  sid: Schema.String.check(Schema.isNonEmpty()),
  iss: Schema.String,
  aud: Schema.Union([Schema.String, Schema.Array(Schema.String)]),
  azp: Schema.String,
  v: Schema.Literal(2),
  iat: Schema.Int,
  exp: Schema.Int,
  nbf: Schema.optionalKey(Schema.Int),
  fva: Schema.Tuple([Schema.Int, Schema.Int]),
  act: Schema.optionalKey(Schema.Unknown),
  sts: Schema.optionalKey(Schema.String),
});

const decodeSessionClaims = Schema.decodeUnknownOption(SessionClaims);

export const strengthRequired = (reason: RelayAuthenticationStrengthError["reason"]) =>
  new RelayAuthenticationStrengthError({
    code: "authentication_strength_required",
    reason,
    requiredLevel: "multi_factor",
    maxAgeSeconds: 600,
    traceId: "connect-auth",
  });

export function normalizeSessionAssurance(
  claims: unknown,
  now: number,
  authGeneration: number,
): ConnectSessionAssurance | null {
  const decoded = decodeSessionClaims(claims);
  if (decoded._tag === "None") return null;
  const value = decoded.value;
  if (
    value.act !== undefined ||
    (value.sts !== undefined && value.sts !== "active") ||
    value.iat > now ||
    value.iat < 0 ||
    value.exp <= now ||
    (value.nbf !== undefined && value.nbf > now) ||
    value.fva.some((age) => !Number.isSafeInteger(age) || age < 0)
  )
    return null;
  const floors = value.fva.map((age) => value.iat - 60 * (age + 1));
  const first = floors[0];
  const second = floors[1];
  if (
    first === undefined ||
    second === undefined ||
    !Number.isSafeInteger(first) ||
    !Number.isSafeInteger(second) ||
    first < 0 ||
    second < 0
  )
    return null;
  return {
    policyVersion: 1,
    source: "clerk-session",
    userId: value.sub,
    sessionId: value.sid,
    firstVerifiedAtFloor: first,
    secondVerifiedAtFloor: second,
    checkedAt: now,
    authGeneration,
  };
}

export class ConnectAuthentication extends Context.Service<
  ConnectAuthentication,
  {
    readonly session: (
      token: string,
      fresh?: boolean,
    ) => Effect.Effect<
      ConnectSessionAssurance,
      | RelayAuthenticationStrengthError
      | RelayAuthInvalidError
      | RelayAuthenticationUnavailableError
      | RelayInternalError
    >;
    readonly oauth: (token: string) => Effect.Effect<
      {
        readonly sub: string;
        readonly oauthClientId: string;
        readonly mode: "clerk_oauth_bearer";
        readonly authentication: {
          readonly source: "clerk-oauth";
          readonly oauthClientId: string;
          readonly assurance: null;
        };
      },
      RelayAuthInvalidError | RelayAuthenticationUnavailableError
    >;
  }
>()("goat-relay/auth/ConnectAuthentication") {}

const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const accounts = yield* ConnectAccounts.ConnectAccounts;
  const invalid = () =>
    new RelayAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_bearer",
      traceId: "connect-auth",
    });
  const unavailable = () =>
    new RelayAuthenticationUnavailableError({
      code: "authentication_provider_unavailable",
      retryable: true,
      traceId: "connect-auth",
    });
  const client = () =>
    createClerkClient({
      secretKey: Redacted.value(config.clerkSecretKey),
      publishableKey: config.clerkPublishableKey,
    });
  const session = Effect.fn("ConnectAuthentication.session")(function* (
    token: string,
    fresh = false,
  ) {
    const issuer = yield* Effect.try({
      try: () => clerkFrontendApiUrlFromPublishableKey(config.clerkPublishableKey),
      catch: unavailable,
    });
    if (config.clerkJwtAudience !== config.relayIssuer.replace(/\/+$/u, ""))
      return yield* unavailable();
    const parties = config.clerkAuthorizedParties ?? [];
    if (parties.length === 0) return yield* unavailable();
    const claims = yield* Effect.tryPromise({
      try: () =>
        verifyToken(token, {
          secretKey: Redacted.value(config.clerkSecretKey),
          audience: config.clerkJwtAudience,
          authorizedParties: [...parties],
        }),
      catch: (cause) =>
        typeof cause === "object" &&
        cause !== null &&
        "reason" in cause &&
        cause.reason === "jwk-remote-failed-to-load"
          ? unavailable()
          : invalid(),
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.catchTags({ TimeoutError: () => Effect.fail(unavailable()) }),
    );
    if (
      claims.iss !== issuer ||
      !parties.includes(String(claims.azp)) ||
      !(typeof claims.aud === "string"
        ? claims.aud === config.clerkJwtAudience
        : Array.isArray(claims.aud) && claims.aud.includes(config.clerkJwtAudience))
    )
      return yield* invalid();
    const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
    const generation = yield* accounts.authorize(claims.sub);
    const assurance = normalizeSessionAssurance(claims, now, generation);
    if (!assurance) return yield* strengthRequired("mfa_required");
    const active = yield* Effect.tryPromise({
      try: () => client().sessions.getSession(assurance.sessionId),
      catch: unavailable,
    }).pipe(
      Effect.timeout("10 seconds"),
      Effect.catchTags({ TimeoutError: () => Effect.fail(unavailable()) }),
    );
    if (active.status !== "active" || active.userId !== assurance.userId)
      return yield* strengthRequired("session_not_active");
    if (fresh && !isConnectAssuranceFresh(assurance, now))
      return yield* strengthRequired("reauthentication_required");
    return assurance;
  });
  const oauth = Effect.fn("ConnectAuthentication.oauth")(function* (token: string) {
    if (!config.clerkCliOAuthClientId) return yield* invalid();
    const state = yield* Effect.tryPromise({
      try: () =>
        client().authenticateRequest(
          new Request(config.relayIssuer, { headers: { authorization: `Bearer ${token}` } }),
          { acceptsToken: "oauth_token" },
        ),
      catch: unavailable,
    });
    const auth = state.toAuth();
    if (
      !state.isAuthenticated ||
      !auth.userId ||
      auth.tokenType !== "oauth_token" ||
      auth.clientId !== config.clerkCliOAuthClientId ||
      !CONNECT_OAUTH_SCOPES.every((scope) => auth.scopes.includes(scope))
    )
      return yield* invalid();
    return {
      sub: auth.userId,
      oauthClientId: auth.clientId,
      mode: "clerk_oauth_bearer" as const,
      authentication: {
        source: "clerk-oauth" as const,
        oauthClientId: auth.clientId,
        assurance: null,
      },
    };
  });
  return ConnectAuthentication.of({ session, oauth });
});
export const layer = Layer.effect(ConnectAuthentication, make);
