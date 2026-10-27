import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const CONNECT_AUTH_POLICY_VERSION = 1;
export const CONNECT_REAUTH_MAX_AGE_SECONDS = 600;
const EpochSeconds = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

export const ConnectSessionAssurance = Schema.Struct({
  policyVersion: Schema.Literal(1),
  source: Schema.Literal("clerk-session"),
  userId: TrimmedNonEmptyString,
  sessionId: TrimmedNonEmptyString,
  firstVerifiedAtFloor: EpochSeconds,
  secondVerifiedAtFloor: EpochSeconds,
  checkedAt: EpochSeconds,
  authGeneration: EpochSeconds,
});
export type ConnectSessionAssurance = typeof ConnectSessionAssurance.Type;

export const ConnectAuthenticationContext = Schema.Union([
  Schema.Struct({ source: Schema.Literal("clerk-session"), assurance: ConnectSessionAssurance }),
  Schema.Struct({
    source: Schema.Literal("clerk-oauth"),
    oauthClientId: TrimmedNonEmptyString,
    assurance: Schema.Null,
  }),
]);
export type ConnectAuthenticationContext = typeof ConnectAuthenticationContext.Type;

export const ConnectLinkIntent = Schema.Struct({
  connectAuthPolicyVersion: Schema.Literal(1),
  environmentId: TrimmedNonEmptyString,
  environmentPublicKey: TrimmedNonEmptyString,
  origin: Schema.Struct({
    localHttpHost: TrimmedNonEmptyString,
    localHttpPort: Schema.Int.check(
      Schema.isGreaterThanOrEqualTo(1),
      Schema.isLessThanOrEqualTo(65535),
    ),
  }),
  notificationsEnabled: Schema.Literal(false),
  liveActivitiesEnabled: Schema.Literal(false),
  managedTunnelsEnabled: Schema.Boolean,
});
export type ConnectLinkIntent = typeof ConnectLinkIntent.Type;

export const CliLinkApprovalRequest = Schema.Struct({
  intent: ConnectLinkIntent,
  cliKeyThumbprint: TrimmedNonEmptyString,
  approvalChallenge: TrimmedNonEmptyString,
  state: TrimmedNonEmptyString,
});
export type CliLinkApprovalRequest = typeof CliLinkApprovalRequest.Type;
export const CliLinkApprovalResponse = Schema.Struct({
  approval: TrimmedNonEmptyString,
  expiresAt: TrimmedNonEmptyString,
});

export class RelayAuthenticationStrengthError extends Schema.TaggedError<RelayAuthenticationStrengthError>()(
  "RelayAuthenticationStrengthError",
  {
    code: Schema.Literal("authentication_strength_required"),
    reason: Schema.Literals([
      "mfa_required",
      "reauthentication_required",
      "session_not_active",
      "unsupported_authentication_flow",
    ]),
    requiredLevel: Schema.Literal("multi_factor"),
    maxAgeSeconds: Schema.Literal(600),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  override get message() {
    return "Verify both authentication factors to continue with GOAT Connect.";
  }
}

export class RelayConnectUpgradeRequiredError extends Schema.TaggedError<RelayConnectUpgradeRequiredError>()(
  "RelayConnectUpgradeRequiredError",
  {
    code: Schema.Literal("connect_upgrade_required"),
    requiredPolicyVersion: Schema.Literal(1),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 409 },
) {
  override get message() {
    return "Update GOAT and re-link this environment to use Connect authentication policy 1.";
  }
}

export function connectAssuranceFreshnessDeadline(assurance: ConnectSessionAssurance): number {
  return (
    Math.min(assurance.firstVerifiedAtFloor, assurance.secondVerifiedAtFloor) +
    CONNECT_REAUTH_MAX_AGE_SECONDS
  );
}

export function isConnectAssuranceFresh(assurance: ConnectSessionAssurance, now: number): boolean {
  return (
    assurance.policyVersion === 1 &&
    assurance.checkedAt <= now &&
    assurance.firstVerifiedAtFloor <= assurance.checkedAt &&
    assurance.secondVerifiedAtFloor <= assurance.checkedAt &&
    now < connectAssuranceFreshnessDeadline(assurance)
  );
}

export const ConnectLinkChallengeRequest = Schema.Struct({
  connectAuthPolicyVersion: Schema.optionalKey(Schema.Literal(1)),
  environmentId: Schema.optionalKey(TrimmedNonEmptyString),
  environmentPublicKey: Schema.optionalKey(TrimmedNonEmptyString),
  origin: Schema.optionalKey(ConnectLinkIntent.fields.origin),
  cliApproval: Schema.optionalKey(TrimmedNonEmptyString),
  approvalVerifier: Schema.optionalKey(TrimmedNonEmptyString),
  approvalState: Schema.optionalKey(TrimmedNonEmptyString),
  notificationsEnabled: Schema.Boolean.annotate({
    description: "Whether this link may deliver push notifications.",
  }),
  liveActivitiesEnabled: Schema.Boolean.annotate({
    description: "Whether this link may update Live Activities.",
  }),
  managedTunnelsEnabled: Schema.Boolean.annotate({
    description: "Whether the relay should provision a managed tunnel for this environment.",
  }),
}).annotate({ description: "Requested capabilities for a new environment-link challenge." });
export type ConnectLinkChallengeRequest = typeof ConnectLinkChallengeRequest.Type;
