import * as Schema from "effect/Schema";
import { DpopFailureReason, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  ConnectAuthenticationErrors,
  RelayAuthenticationStrengthError,
} from "./connectAssurance.ts";

export { RelayAuthenticationStrengthError };

export const RelayRateLimitOperation = Schema.Literals([
  "link_challenge",
  "link",
  "dpop_token",
  "connect",
  "mobile_registration",
  "activity_publish",
]);
export type RelayRateLimitOperation = typeof RelayRateLimitOperation.Type;
export class RelayAccountAccessDeniedError extends Schema.TaggedError<RelayAccountAccessDeniedError>()(
  "RelayAccountAccessDeniedError",
  {
    code: Schema.Literal("account_access_denied"),
    reason: Schema.Literals(["not_invited", "suspended", "account_deleted"]),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return "This account does not have GOAT Connect access.";
  }
}
export class RelayAccountEpochStaleError extends Schema.TaggedError<RelayAccountEpochStaleError>()(
  "RelayAccountEpochStaleError",
  Schema.Struct({
    code: Schema.Literal("account_epoch_stale"),
    credentialKind: Schema.Literals(["dpop", "link_challenge", "environment"]),
    action: Schema.Literals(["refresh_token", "new_challenge", "relink"]),
    traceId: TrimmedNonEmptyString,
  }).check(
    Schema.makeFilter(
      (value) =>
        value.action ===
        (value.credentialKind === "dpop"
          ? "refresh_token"
          : value.credentialKind === "link_challenge"
            ? "new_challenge"
            : "relink"),
    ),
  ),
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return "This credential belongs to an earlier account epoch.";
  }
}
export class RelayEnvironmentRelinkRequiredError extends Schema.TaggedError<RelayEnvironmentRelinkRequiredError>()(
  "RelayEnvironmentRelinkRequiredError",
  { code: Schema.Literal("environment_relink_required"), traceId: TrimmedNonEmptyString },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return "Link this environment again to restore GOAT Connect.";
  }
}
export class RelayEnvironmentOwnerConflictError extends Schema.TaggedError<RelayEnvironmentOwnerConflictError>()(
  "RelayEnvironmentOwnerConflictError",
  { code: Schema.Literal("environment_owner_conflict"), traceId: TrimmedNonEmptyString },
  { httpApiStatus: 409 },
) {
  override get message(): string {
    return "Another account owns this environment. Unlink and clean up the existing account before linking again.";
  }
}
export class RelayEnvironmentOwnerMismatchError extends Schema.TaggedError<RelayEnvironmentOwnerMismatchError>()(
  "RelayEnvironmentOwnerMismatchError",
  { code: Schema.Literal("environment_owner_mismatch"), traceId: TrimmedNonEmptyString },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return "The authenticated account does not own this environment.";
  }
}
export class RelayAccountResourceLimitExceededError extends Schema.TaggedError<RelayAccountResourceLimitExceededError>()(
  "RelayAccountResourceLimitExceededError",
  {
    code: Schema.Literal("account_resource_limit_exceeded"),
    resource: Schema.Literals(["environment_links", "mobile_devices"]),
    limit: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return "The account resource limit has been reached.";
  }
}
export class RelayMobileDeviceNotRegisteredError extends Schema.TaggedError<RelayMobileDeviceNotRegisteredError>()(
  "RelayMobileDeviceNotRegisteredError",
  { code: Schema.Literal("mobile_device_not_registered"), traceId: TrimmedNonEmptyString },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return "Register this mobile device before starting a Live Activity.";
  }
}
export class RelayRateLimitExceededError extends Schema.TaggedError<RelayRateLimitExceededError>()(
  "RelayRateLimitExceededError",
  {
    code: Schema.Literal("rate_limit_exceeded"),
    operation: RelayRateLimitOperation,
    retryAfterSeconds: Schema.Int.check(Schema.isGreaterThan(0)),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 429 },
) {
  override get message(): string {
    return "GOAT Connect request budget exhausted. Wait before retrying.";
  }
}
export class RelayAuthorizationUnavailableError extends Schema.TaggedError<RelayAuthorizationUnavailableError>()(
  "RelayAuthorizationUnavailableError",
  { code: Schema.Literal("authorization_unavailable"), traceId: TrimmedNonEmptyString },
  { httpApiStatus: 503 },
) {
  override get message(): string {
    return "GOAT Connect authorization is temporarily unavailable.";
  }
}
export class RelayMintDisabledError extends Schema.TaggedError<RelayMintDisabledError>()(
  "RelayMintDisabledError",
  { code: Schema.Literal("relay_mint_disabled"), traceId: TrimmedNonEmptyString },
  { httpApiStatus: 503 },
) {
  override get message(): string {
    return "Relay credential issuance and tunnel provisioning are paused.";
  }
}
export class RelayAccountDeletionConflictError extends Schema.TaggedError<RelayAccountDeletionConflictError>()(
  "RelayAccountDeletionConflictError",
  { code: Schema.Literal("account_deletion_conflict"), traceId: TrimmedNonEmptyString },
  { httpApiStatus: 409 },
) {}
export class RelayAccountDeletionUnavailableError extends Schema.TaggedError<RelayAccountDeletionUnavailableError>()(
  "RelayAccountDeletionUnavailableError",
  { code: Schema.Literal("account_deletion_unavailable"), traceId: TrimmedNonEmptyString },
  { httpApiStatus: 503 },
) {}
export const RelayAccountPolicyErrors = [
  RelayAccountDeletionUnavailableError,
  RelayMintDisabledError,
  RelayAuthenticationStrengthError,
  RelayAccountDeletionConflictError,
  RelayAccountAccessDeniedError,
  RelayAccountEpochStaleError,
  RelayEnvironmentRelinkRequiredError,
  RelayEnvironmentOwnerConflictError,
  RelayEnvironmentOwnerMismatchError,
  RelayAccountResourceLimitExceededError,
  RelayMobileDeviceNotRegisteredError,
  RelayRateLimitExceededError,
  RelayAuthorizationUnavailableError,
] as const;

export const RelayEnvironmentLinkProofInvalidReason = Schema.Literals([
  "invalid_signature_or_scope",
  "descriptor_mismatch",
  "replayed_nonce",
  "challenge_invalid",
  "origin_not_allowed",
  "endpoint_not_secure",
]);
export type RelayEnvironmentLinkProofInvalidReason =
  typeof RelayEnvironmentLinkProofInvalidReason.Type;

export const RelayEnvironmentLinkFailedReason = Schema.Literals([
  "link_persistence_failed",
  "credential_persistence_failed",
  "replay_persistence_failed",
  "internal_error",
]);
export type RelayEnvironmentLinkFailedReason = typeof RelayEnvironmentLinkFailedReason.Type;

export const RelayEnvironmentLinkUnavailableReason = Schema.Literals([
  "managed_endpoint_not_configured",
  "managed_endpoint_provisioning_failed",
]);
export type RelayEnvironmentLinkUnavailableReason =
  typeof RelayEnvironmentLinkUnavailableReason.Type;

export const RelayEnvironmentEndpointUnavailableReason = Schema.Literals([
  "endpoint_request_failed",
  "endpoint_response_invalid",
]);
export type RelayEnvironmentEndpointUnavailableReason =
  typeof RelayEnvironmentEndpointUnavailableReason.Type;

/**
 * Which part of the path from the relay to the environment failed. `tunnel_down`
 * means Cloudflare has no live connector for the tunnel; `origin_unreachable`
 * means the tunnel answered but GOAT behind it did not. Optional on the wire
 * so old relays and old clients keep working.
 */
export const RelayEnvironmentEndpointFailure = Schema.Literals([
  "tunnel_down",
  "origin_unreachable",
  "dns",
  "tls",
  "refused",
  "timeout",
  "invalid_response",
  "unknown",
]);
export type RelayEnvironmentEndpointFailure = typeof RelayEnvironmentEndpointFailure.Type;

export const RelayAgentActivityPublishProofInvalidReason = Schema.Literals([
  "invalid_signature_or_payload",
  "replayed_nonce",
]);
export type RelayAgentActivityPublishProofInvalidReason =
  typeof RelayAgentActivityPublishProofInvalidReason.Type;

export const RelayAuthInvalidReason = Schema.Literals([
  "missing_bearer",
  "invalid_bearer",
  "invalid_dpop",
  "not_authorized",
]);
export type RelayAuthInvalidReason = typeof RelayAuthInvalidReason.Type;

export const RelayDpopFailureReason = DpopFailureReason;
export type RelayDpopFailureReason = typeof RelayDpopFailureReason.Type;

export const RelayInternalErrorReason = Schema.Literals([
  "database_unavailable",
  "persistence_failed",
  "upstream_unavailable",
  "internal_error",
]);
export type RelayInternalErrorReason = typeof RelayInternalErrorReason.Type;

export class RelayAuthInvalidError extends Schema.TaggedError<RelayAuthInvalidError>()(
  "RelayAuthInvalidError",
  {
    code: Schema.Literal("auth_invalid"),
    reason: RelayAuthInvalidReason,
    dpopFailureReason: Schema.optionalKey(RelayDpopFailureReason),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return `Relay authentication failed: ${this.reason}`;
  }
}

export class RelayEnvironmentLinkProofExpiredError extends Schema.TaggedError<RelayEnvironmentLinkProofExpiredError>()(
  "RelayEnvironmentLinkProofExpiredError",
  {
    code: Schema.Literal("environment_link_proof_expired"),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return "Relay environment link proof expired";
  }
}

export class RelayEnvironmentLinkProofInvalidError extends Schema.TaggedError<RelayEnvironmentLinkProofInvalidError>()(
  "RelayEnvironmentLinkProofInvalidError",
  {
    code: Schema.Literal("environment_link_proof_invalid"),
    reason: RelayEnvironmentLinkProofInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 400 },
) {
  override get message(): string {
    return `Relay environment link proof is invalid: ${this.reason}`;
  }
}

export const RelayEnvironmentConnectNotAuthorizedReason = Schema.Literals([
  "client_proof_key_thumbprint_missing",
  "environment_link_not_found",
  "endpoint_provider_not_managed",
  "managed_endpoint_allocation_not_found",
  "managed_endpoint_base_domain_not_configured",
  "managed_endpoint_allocation_not_ready",
  "managed_endpoint_hostname_invalid",
  "managed_endpoint_mismatch",
]);
export type RelayEnvironmentConnectNotAuthorizedReason =
  typeof RelayEnvironmentConnectNotAuthorizedReason.Type;

export class RelayEnvironmentConnectNotAuthorizedError extends Schema.TaggedError<RelayEnvironmentConnectNotAuthorizedError>()(
  "RelayEnvironmentConnectNotAuthorizedError",
  {
    code: Schema.Literal("environment_connect_not_authorized"),
    reason: Schema.optional(RelayEnvironmentConnectNotAuthorizedReason),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return this.reason
      ? `Relay environment connection is not authorized: ${this.reason}`
      : "Relay environment connection is not authorized";
  }
}

export class RelayEnvironmentEndpointUnavailableError extends Schema.TaggedError<RelayEnvironmentEndpointUnavailableError>()(
  "RelayEnvironmentEndpointUnavailableError",
  {
    code: Schema.Literal("environment_endpoint_unavailable"),
    reason: RelayEnvironmentEndpointUnavailableReason,
    endpointFailure: Schema.optionalKey(RelayEnvironmentEndpointFailure),
    endpointStatus: Schema.optionalKey(Schema.Number),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 502 },
) {
  override get message(): string {
    return `Relay environment endpoint is unavailable: ${this.reason}`;
  }
}

export class RelayEnvironmentEndpointTimedOutError extends Schema.TaggedError<RelayEnvironmentEndpointTimedOutError>()(
  "RelayEnvironmentEndpointTimedOutError",
  {
    code: Schema.Literal("environment_endpoint_timed_out"),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 504 },
) {
  override get message(): string {
    return "Relay environment endpoint request timed out";
  }
}

export class RelayEnvironmentLinkFailedError extends Schema.TaggedError<RelayEnvironmentLinkFailedError>()(
  "RelayEnvironmentLinkFailedError",
  {
    code: Schema.Literal("environment_link_failed"),
    reason: RelayEnvironmentLinkFailedReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 500 },
) {
  override get message(): string {
    return `Relay environment link failed: ${this.reason}`;
  }
}

export class RelayEnvironmentLinkUnavailableError extends Schema.TaggedError<RelayEnvironmentLinkUnavailableError>()(
  "RelayEnvironmentLinkUnavailableError",
  {
    code: Schema.Literal("environment_link_unavailable"),
    reason: RelayEnvironmentLinkUnavailableReason,
    provisioningStage: Schema.optionalKey(TrimmedNonEmptyString),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 503 },
) {
  override get message(): string {
    return `Relay environment link is unavailable: ${this.reason}`;
  }
}

export class RelayEnvironmentLinkLimitExceededError extends Schema.TaggedError<RelayEnvironmentLinkLimitExceededError>()(
  "RelayEnvironmentLinkLimitExceededError",
  {
    code: Schema.Literal("environment_link_limit_exceeded"),
    maxTunnels: Schema.Number,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 403 },
) {
  override get message(): string {
    return `Relay managed tunnel limit reached: this account allows at most ${this.maxTunnels} tunnels`;
  }
}

export class RelayAgentActivityPublishProofExpiredError extends Schema.TaggedError<RelayAgentActivityPublishProofExpiredError>()(
  "RelayAgentActivityPublishProofExpiredError",
  {
    code: Schema.Literal("agent_activity_publish_proof_expired"),
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return "Relay agent activity publish proof expired";
  }
}

export class RelayAgentActivityPublishProofInvalidError extends Schema.TaggedError<RelayAgentActivityPublishProofInvalidError>()(
  "RelayAgentActivityPublishProofInvalidError",
  {
    code: Schema.Literal("agent_activity_publish_proof_invalid"),
    reason: RelayAgentActivityPublishProofInvalidReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 401 },
) {
  override get message(): string {
    return `Relay agent activity publish proof is invalid: ${this.reason}`;
  }
}

export class RelayInternalError extends Schema.TaggedError<RelayInternalError>()(
  "RelayInternalError",
  {
    code: Schema.Literal("internal_error"),
    reason: RelayInternalErrorReason,
    traceId: TrimmedNonEmptyString,
  },
  { httpApiStatus: 500 },
) {
  override get message(): string {
    return `Relay internal error: ${this.reason}`;
  }
}

export const RelayProtectedError = Schema.Union([
  ...RelayAccountPolicyErrors,
  ...ConnectAuthenticationErrors,
  RelayAuthInvalidError,
  RelayEnvironmentLinkProofExpiredError,
  RelayEnvironmentLinkProofInvalidError,
  RelayEnvironmentConnectNotAuthorizedError,
  RelayEnvironmentEndpointUnavailableError,
  RelayEnvironmentEndpointTimedOutError,
  RelayEnvironmentLinkFailedError,
  RelayEnvironmentLinkUnavailableError,
  RelayEnvironmentLinkLimitExceededError,
  RelayAgentActivityPublishProofExpiredError,
  RelayAgentActivityPublishProofInvalidError,
  RelayInternalError,
]);
export type RelayProtectedError = typeof RelayProtectedError.Type;
