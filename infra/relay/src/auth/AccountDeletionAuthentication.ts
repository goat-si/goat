import { createClerkClient, verifyToken } from "@clerk/backend";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import {
  RelayAuthenticationStrengthError,
  RelayAuthInvalidError,
  RelayAuthorizationUnavailableError,
} from "@goat/contracts/relayErrors";
import { RelayConfiguration } from "../Config.ts";

const strength = (reason: RelayAuthenticationStrengthError["reason"]) =>
  new RelayAuthenticationStrengthError({
    code: "authentication_strength_required",
    reason,
    requiredLevel: "multi_factor",
    maxAgeSeconds: 600,
    traceId: "relay",
  });
const Ages = Schema.Tuple([
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
]);
// wp7's signed session fva ages are minute snapshots; preserve its conservative lower bounds.
export const requireFreshMfa = Effect.fn("AccountDeletionAuthentication.requireFreshMfa")(
  function* (claims: { readonly fva?: unknown; readonly iat?: number }, now: number) {
    const ages = yield* Schema.decodeUnknownEffect(Ages)(claims.fva).pipe(
      Effect.mapError(() => strength("mfa_required")),
    );
    if (!Number.isSafeInteger(claims.iat) || claims.iat === undefined || claims.iat > now)
      return yield* strength("reauthentication_required");
    const issuedAt = claims.iat;
    const floors = ages.map((age) => issuedAt - 60 * (age + 1));
    if (floors.some((floor) => !Number.isSafeInteger(floor) || now >= floor + 600))
      return yield* strength("reauthentication_required");
  },
);
export class AccountDeletionAuthentication extends Context.Service<
  AccountDeletionAuthentication,
  {
    readonly authenticate: (
      token: string,
      fresh: boolean,
    ) => Effect.Effect<
      string,
      RelayAuthInvalidError | RelayAuthenticationStrengthError | RelayAuthorizationUnavailableError
    >;
  }
>()("goat-relay/auth/AccountDeletionAuthentication") {}
const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration;
  const invalid = () =>
    new RelayAuthInvalidError({ code: "auth_invalid", reason: "invalid_bearer", traceId: "relay" });
  const unavailable = () =>
    new RelayAuthorizationUnavailableError({ code: "authorization_unavailable", traceId: "relay" });
  return AccountDeletionAuthentication.of({
    authenticate: Effect.fn("AccountDeletionAuthentication.authenticate")(function* (token, fresh) {
      if (!config.clerkSessionIssuer || !config.clerkAuthorizedParties?.length)
        return yield* unavailable();
      const claims = yield* Effect.tryPromise({
        try: () =>
          verifyToken(token, {
            secretKey: Redacted.value(config.clerkSecretKey),
            audience: config.clerkJwtAudience,
            authorizedParties: [...(config.clerkAuthorizedParties ?? [])],
          }),
        catch: invalid,
      });
      if (
        claims.iss !== config.clerkSessionIssuer ||
        !claims.sub ||
        typeof claims.sid !== "string" ||
        !claims.sid ||
        claims.v !== 2 ||
        claims.act !== undefined ||
        !config.clerkAuthorizedParties.includes(String(claims.azp))
      )
        return yield* strength("unsupported_authentication_flow");
      const sessionId = claims.sid;
      const session = yield* Effect.tryPromise({
        try: () =>
          createClerkClient({
            secretKey: Redacted.value(config.clerkSecretKey),
          }).sessions.getSession(sessionId),
        catch: unavailable,
      });
      if (session.status !== "active" || session.userId !== claims.sub)
        return yield* strength("session_not_active");
      if (fresh)
        yield* requireFreshMfa(claims, Math.floor((yield* DateTime.now).epochMilliseconds / 1000));
      return claims.sub;
    }),
  });
});
export const layer = Layer.effect(AccountDeletionAuthentication, make);
