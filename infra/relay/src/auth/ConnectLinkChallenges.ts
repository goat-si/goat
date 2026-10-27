import {
  ConnectLinkIntent,
  isConnectAssuranceFresh,
  RelayConnectUpgradeRequiredError,
  type ConnectAuthenticationContext,
} from "@goat/contracts/connectAssurance";
import { type RelayEnvironmentLinkChallengeRequest } from "@goat/contracts/relay";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as CliLinkApprovals from "./CliLinkApprovals.ts";
import * as RelayTokens from "./RelayTokens.ts";
import { strengthRequired } from "./ConnectAuthentication.ts";

const decodeIntent = Schema.decodeUnknownOption(ConnectLinkIntent);

export const createLinkChallenge = Effect.fn("ConnectLinkChallenges.create")(function* (input: {
  readonly request: RelayEnvironmentLinkChallengeRequest;
  readonly userId: string;
  readonly authentication: ConnectAuthenticationContext | undefined;
  readonly thumbprint?: string;
}) {
  const decoded = decodeIntent(input.request);
  if (decoded._tag === "None")
    return yield* new RelayConnectUpgradeRequiredError({
      code: "connect_upgrade_required",
      requiredPolicyVersion: 1,
      traceId: "connect-link",
    });
  const intent = decoded.value;
  if (
    intent.origin.localHttpHost !== "127.0.0.1" &&
    intent.origin.localHttpHost !== "localhost" &&
    intent.origin.localHttpHost !== "::1"
  )
    return yield* strengthRequired("unsupported_authentication_flow");
  const auth = input.authentication;
  if (!auth) return yield* strengthRequired("mfa_required");
  const approvals = yield* CliLinkApprovals.CliLinkApprovals;
  const assurance =
    auth.source === "clerk-session"
      ? auth.assurance
      : input.request.cliApproval &&
          input.request.approvalVerifier &&
          input.request.approvalState &&
          input.thumbprint
        ? yield* approvals.consume({
            approval: input.request.cliApproval,
            verifier: input.request.approvalVerifier,
            state: input.request.approvalState,
            userId: input.userId,
            thumbprint: input.thumbprint,
            intent,
          })
        : yield* strengthRequired("unsupported_authentication_flow");
  const now = Math.floor((yield* DateTime.now).epochMilliseconds / 1000);
  if (!isConnectAssuranceFresh(assurance, now))
    return yield* strengthRequired("reauthentication_required");
  const crypto = yield* Crypto.Crypto;
  const tokens = yield* RelayTokens.RelayTokens;
  const expires = Math.min(
    now + 300,
    Math.min(assurance.firstVerifiedAtFloor, assurance.secondVerifiedAtFloor) + 600,
  );
  const challenge = yield* tokens.issueLinkChallenge({
    userId: assurance.userId,
    request: input.request,
    assurance,
    intent,
    ...(input.thumbprint ? { cliKeyThumbprint: input.thumbprint } : {}),
    jti: yield* crypto.randomUUIDv4(),
    issuedAtEpochSeconds: now,
    expiresAtEpochSeconds: expires,
  });
  return { challenge, expiresAt: DateTime.formatIso(DateTime.makeUnsafe(expires * 1000)) };
});
