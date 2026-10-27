import { RelayAccountAccessDeniedError, RelayRateLimitExceededError } from "@goat/contracts/relay";
import { RelayAuthInvalidError } from "@goat/contracts/relay";
import { describe, expect, it } from "@effect/vitest";

import {
  DPOP_CLOCK_HINT,
  DPOP_RETRY_HINT,
  DPOP_UNKNOWN_HINT,
  relayProtectedErrorMessage,
} from "./errorPresentation.ts";

describe("relayProtectedErrorMessage", () => {
  it("presents clock skew as one possible cause when the relay omits the reason", () => {
    const error = new RelayAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_dpop",
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toBe(
      `Relay rejected the DPoP proof. ${DPOP_UNKNOWN_HINT}`,
    );
  });

  it("keeps the clock hint for a relay that confirms a time-window failure", () => {
    const error = new RelayAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_dpop",
      dpopFailureReason: "time_window",
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toContain(DPOP_CLOCK_HINT);
  });

  it("does not blame the clock when the relay identifies another proof failure", () => {
    const error = new RelayAuthInvalidError({
      code: "auth_invalid",
      reason: "invalid_dpop",
      dpopFailureReason: "key_mismatch",
      traceId: "trace-1",
    });

    expect(relayProtectedErrorMessage(error)).toBe(
      `Relay rejected the DPoP proof. ${DPOP_RETRY_HINT}`,
    );
  });
});

it("keeps invite denial and throttling actionable without a sign-in hint", () => {
  const denied = new RelayAccountAccessDeniedError({
    code: "account_access_denied",
    reason: "not_invited",
    traceId: "fixture",
  });
  expect(relayProtectedErrorMessage(denied)).toContain("invite-only");
  const rate = new RelayRateLimitExceededError({
    code: "rate_limit_exceeded",
    operation: "connect",
    retryAfterSeconds: 60,
    traceId: "fixture",
  });
  expect(relayProtectedErrorMessage(rate)).toContain("60 seconds");
});
