import type { DpopFailureReason } from "@goat/contracts";
import type { RelayEnvironmentStatusResponse, RelayProtectedError } from "@goat/contracts/relay";

export const DPOP_CLOCK_HINT =
  "Hint: Check that automatic date and time is enabled on both devices, then try again.";

/** Older servers omit the DPoP category, but newer servers can also omit it for
 * a credential failure that happens after proof verification. */
export const DPOP_UNKNOWN_HINT =
  "Hint: Try again. If it still fails, clock skew may be the cause; check that automatic date and time is enabled on both devices.";

export const DPOP_RETRY_HINT = "Hint: Try again. If the problem continues, copy the trace ID.";

function dpopFailureHint(reason: DpopFailureReason | undefined): string {
  if (reason === "time_window") return DPOP_CLOCK_HINT;
  if (reason === undefined) return DPOP_UNKNOWN_HINT;
  return DPOP_RETRY_HINT;
}

export function dpopFailureMessage(message: string, reason: DpopFailureReason | undefined): string {
  return `${message} ${dpopFailureHint(reason)}`;
}

export function relayProtectedErrorMessage(error: RelayProtectedError): string {
  switch (error._tag) {
    case "RelayAccountDeletionUnavailableError":
      return "Account deletion status is unavailable. Read status again before retrying.";
    case "RelayMintDisabledError":
      return "Relay credential issuance and tunnel provisioning are paused. Try again later.";
    case "RelayAuthenticationStrengthError":
      return "Verify your account with MFA in the last 10 minutes, then try again.";
    case "RelayAccountDeletionConflictError":
      return "A conflicting account request was received. Read deletion status before retrying.";
    case "RelayAccountAccessDeniedError":
      if (error.reason === "account_deleted")
        return "This GOAT Connect account has been deleted. Unlink connected machines locally if cleanup is unconfirmed.";
      return error.reason === "not_invited"
        ? "GOAT Connect is invite-only. Ask the operator for access."
        : "GOAT Connect access is suspended. Contact the operator.";
    case "RelayAccountEpochStaleError":
      return error.action === "refresh_token"
        ? "GOAT Connect credentials changed. Refresh the connection."
        : error.action === "new_challenge"
          ? "Restart linking this environment."
          : "Link this environment again to restore GOAT Connect.";
    case "RelayEnvironmentRelinkRequiredError":
      return "Link this environment again to restore GOAT Connect.";
    case "RelayEnvironmentOwnerConflictError":
      return "Another account owns this environment. Unlink it from that account before linking again.";
    case "RelayEnvironmentOwnerMismatchError":
      return "This account does not own the linked environment.";
    case "RelayAccountResourceLimitExceededError":
      return `This account has reached its limit of ${error.limit} ${error.resource === "mobile_devices" ? "mobile devices" : "environment links"}. Remove an unused one first.`;
    case "RelayMobileDeviceNotRegisteredError":
      return "Register this device before starting a Live Activity.";
    case "RelayRateLimitExceededError":
      return `GOAT Connect request budget exhausted. Try again in ${error.retryAfterSeconds} seconds.`;
    case "RelayAuthorizationUnavailableError":
      return "GOAT Connect authorization is temporarily unavailable. Try again later.";
    case "RelayAuthenticationStrengthError":
      return "Verify both factors again, then retry this action. If your client cannot reverify, sign out and sign in with MFA.";
    case "RelayAuthenticationUnavailableError":
      return "The authentication provider is temporarily unavailable. Try again.";
    case "RelayConnectUpgradeRequiredError":
      return "Update GOAT to a release with Connect policy 1, then re-link this environment.";
    case "RelayAuthInvalidError":
      switch (error.reason) {
        case "missing_bearer":
        case "invalid_bearer":
          return "Relay rejected the cloud session token.";
        case "invalid_dpop":
          return dpopFailureMessage("Relay rejected the DPoP proof.", error.dpopFailureReason);
        case "not_authorized":
          return "Relay rejected the authenticated request.";
      }
    case "RelayEnvironmentLinkProofExpiredError":
      return "Relay rejected an expired environment link proof.";
    case "RelayEnvironmentLinkProofInvalidError":
      return `Relay rejected the environment link proof (${error.reason}).`;
    case "RelayEnvironmentConnectNotAuthorizedError":
      // "Not authorized" covers non-auth causes too; surface the reason so a
      // missing link does not read as a credential problem.
      if (error.reason === "environment_link_not_found") {
        return "Relay has no active link for this environment. If it was deregistered from GOAT Connect, link it again on that machine.";
      }
      if (error.reason === "managed_endpoint_allocation_not_ready") {
        return "The environment's GOAT Connect tunnel is still being set up.";
      }
      if (error.reason === "endpoint_provider_not_managed") {
        return "This environment is linked only to publish agent activity, so it cannot accept connections. On that computer, open Settings > Connections and turn GOAT Connect on.";
      }
      return error.reason
        ? `Relay rejected the environment connection request (${error.reason}).`
        : "Relay rejected the environment connection request.";
    case "RelayEnvironmentEndpointUnavailableError":
      return `Relay could not reach the environment endpoint (${error.reason}).`;
    case "RelayEnvironmentEndpointTimedOutError":
      return "Relay timed out while contacting the environment endpoint.";
    case "RelayEnvironmentLinkFailedError":
      return `Relay could not link the environment (${error.reason}).`;
    case "RelayEnvironmentLinkUnavailableError":
      return `Relay cannot provision the managed endpoint (${error.reason}).${
        error.provisioningStage ? ` Failed stage: ${error.provisioningStage}.` : ""
      }`;
    case "RelayEnvironmentLinkLimitExceededError":
      return `Relay refused the link: this account already has its maximum of ${error.maxTunnels} managed tunnels. Unlink an environment to free one up.`;
    case "RelayAgentActivityPublishProofExpiredError":
      return "Relay rejected an expired agent activity publish proof.";
    case "RelayAgentActivityPublishProofInvalidError":
      return `Relay rejected the agent activity publish proof (${error.reason}).`;
    case "RelayInternalError":
      return `Relay encountered an internal error (${error.reason}).`;
  }
}

// The relay cuts off a request it cannot finish in time with a 504 that no
// endpoint declares, so the client sees only the status.
export const RELAY_GATEWAY_TIMEOUT_MESSAGE =
  "Relay timed out before it finished the request (HTTP 504). Try again in a few minutes. If it keeps failing, copy the trace ID when you report it.";

export function relayRequestFailureDetail(error: {
  readonly relayError?: RelayProtectedError | undefined;
  readonly status?: number | undefined;
}): string | null {
  if (error.relayError) return relayProtectedErrorMessage(error.relayError);
  if (error.status === 403)
    return "GOAT Connect refused access. Check your invitation, account status, and resource limits.";
  if (error.status === 429) return "GOAT Connect request budget exhausted. Wait before retrying.";
  if (error.status === 503) return "GOAT Connect is temporarily unavailable.";
  if (error.status === 504) return RELAY_GATEWAY_TIMEOUT_MESSAGE;
  if (error.status !== undefined) return `Relay returned an unexpected HTTP ${error.status}.`;
  return null;
}

const RELAY_TUNNEL_RELEASED_MESSAGE =
  "Offline for a while, so its GOAT Connect tunnel was removed. Start GOAT on that computer and update it to the latest version to reconnect.";

export function relayOfflineReasonMessage(
  status: Pick<RelayEnvironmentStatusResponse, "offlineReason">,
): string | null {
  switch (status.offlineReason) {
    case "tunnel_released":
      return RELAY_TUNNEL_RELEASED_MESSAGE;
    case undefined:
      return null;
  }
}
