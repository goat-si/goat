import * as ConnectAccounts from "./ConnectAccounts.ts";
import {
  CliLinkApprovalRequest,
  ConnectSessionAssurance,
  isConnectAssuranceFresh,
  connectAssuranceFreshnessDeadline,
  type ConnectLinkIntent,
} from "@goat/contracts/connectAssurance";
import { RelayInternalError } from "@goat/contracts/relay";
import { normalizeRelayIssuer, signRelayJwt, verifyRelayJwt } from "@goat/shared/relayJwt";
import { stableStringify } from "@goat/shared/relaySigning";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Base64Url from "effect/encoding/Base64Url";
import * as RelayConfiguration from "../Config.ts";
import * as DpopProofs from "./DpopProofs.ts";
import { strengthRequired } from "./ConnectAuthentication.ts";

const TYP = "goat-cli-link-approval+jwt";
const Claims = Schema.Struct({
  ...CliLinkApprovalRequest.fields,
  assurance: ConnectSessionAssurance,
  iss: Schema.String,
  aud: Schema.String,
  sub: Schema.String,
  jti: Schema.String,
  iat: Schema.Int,
  exp: Schema.Int,
  scope: Schema.Literal("environment:link"),
});

export class CliLinkApprovals extends Context.Service<
  CliLinkApprovals,
  {
    readonly issue: (
      request: CliLinkApprovalRequest,
      assurance: ConnectSessionAssurance,
    ) => Effect.Effect<
      { readonly approval: string; readonly expiresAt: string },
      | ReturnType<typeof strengthRequired>
      | import("@goat/shared/relayJwt").RelayJwtError
      | RelayInternalError
    >;
    readonly consume: (input: {
      readonly approval: string;
      readonly verifier: string;
      readonly state: string;
      readonly userId: string;
      readonly thumbprint: string;
      readonly intent: ConnectLinkIntent;
    }) => Effect.Effect<
      ConnectSessionAssurance,
      | ReturnType<typeof strengthRequired>
      | DpopProofs.DpopProofReplayPersistenceError
      | RelayInternalError
    >;
  }
>()("goat-relay/auth/CliLinkApprovals") {}

const make = Effect.gen(function* () {
  const config = yield* RelayConfiguration.RelayConfiguration;
  const crypto = yield* Crypto.Crypto;
  const replay = yield* DpopProofs.DpopProofReplay;
  const accounts = yield* ConnectAccounts.ConnectAccounts;
  const unavailable = () =>
    new RelayInternalError({
      code: "internal_error",
      reason: "internal_error",
      traceId: "cli-approval",
    });
  const issuer = normalizeRelayIssuer(config.relayIssuer);
  const issue = Effect.fn("CliLinkApprovals.issue")(function* (
    request: CliLinkApprovalRequest,
    assurance: ConnectSessionAssurance,
  ) {
    const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
    if (!isConnectAssuranceFresh(assurance, now))
      return yield* strengthRequired("reauthentication_required");
    const expires = Math.min(now + 120, connectAssuranceFreshnessDeadline(assurance));
    const approval = yield* signRelayJwt({
      privateKey: Redacted.value(config.cloudMintPrivateKey),
      typ: TYP,
      payload: {
        ...request,
        assurance,
        iss: issuer,
        aud: issuer,
        sub: assurance.userId,
        jti: yield* crypto.randomUUIDv4().pipe(Effect.mapError(unavailable)),
        iat: now,
        exp: expires,
        scope: "environment:link",
      },
    });
    return { approval, expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expires * 1000)) };
  });
  const consume = Effect.fn("CliLinkApprovals.consume")(function* (
    input: Parameters<CliLinkApprovals["Service"]["consume"]>[0],
  ) {
    const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
    const decoded = yield* verifyRelayJwt({
      publicKey: config.cloudMintPublicKey,
      token: input.approval,
      typ: TYP,
      issuer,
      audience: issuer,
      nowEpochSeconds: now,
    }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Claims)), Effect.option);
    if (decoded._tag === "None") return yield* strengthRequired("unsupported_authentication_flow");
    const claims = decoded.value;
    if (!(yield* accounts.check(claims.sub, claims.assurance.authGeneration)))
      return yield* strengthRequired("session_not_active");
    const challenge = Base64Url.encode(
      yield* crypto
        .digest("SHA-256", new TextEncoder().encode(input.verifier))
        .pipe(Effect.mapError(unavailable)),
    );
    if (
      claims.exp <= now ||
      claims.iat > now ||
      input.verifier.length < 43 ||
      input.verifier.length > 128 ||
      claims.sub !== input.userId ||
      claims.assurance.userId !== input.userId ||
      claims.cliKeyThumbprint !== input.thumbprint ||
      claims.state !== input.state ||
      claims.approvalChallenge !== challenge ||
      stableStringify(claims.intent) !== stableStringify(input.intent) ||
      claims.exp > claims.iat + 120 ||
      !isConnectAssuranceFresh(claims.assurance, now)
    )
      return yield* strengthRequired("reauthentication_required");
    const consumed = yield* replay.consume({
      thumbprint: "cli-link-approval",
      jti: claims.jti,
      iat: claims.iat,
      expiresAt: DateTime.makeUnsafe(claims.exp * 1000),
    });
    if (!consumed) return yield* strengthRequired("unsupported_authentication_flow");
    return claims.assurance;
  });
  return CliLinkApprovals.of({ issue, consume });
});
export const layer = Layer.effect(CliLinkApprovals, make);
