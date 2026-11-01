import { describe, expect, it } from "@effect/vitest";

import {
  codexRetryFailureClass,
  codexTerminalFailure,
  codexUsageLimitError,
  settledCodexFailure,
} from "./CodexFailureClass.ts";

// What OpenCodex returned for a CommandCode model the account's plan lacks (#1205).
const NOT_IN_PLAN =
  'unexpected status 403 Forbidden: Provider error 403: {"success":false,"error":{"code":"FORBIDDEN","status":403,"message":"MODEL_NOT_IN_PLAN: available in Pro and above plans"}}, url: http://127.0.0.1:10100/v1/responses';

describe("Codex failure classes", () => {
  it("a route that refuses the model for this account is a permission error, never retried", () => {
    const exhausted = { responseTooManyFailedAttempts: { httpStatusCode: 403 } };
    expect(codexTerminalFailure("responseTooManyFailedAttempts", exhausted, NOT_IN_PLAN)).toEqual({
      class: "permission_error",
      retryable: false,
    });
    // The status alone, or the provider's message alone, is enough.
    expect(codexTerminalFailure("responseTooManyFailedAttempts", exhausted, "failed").class).toBe(
      "permission_error",
    );
    expect(codexTerminalFailure("other", "other", NOT_IN_PLAN).class).toBe("permission_error");
    expect(
      codexRetryFailureClass(
        "responseStreamConnectionFailed",
        { responseStreamConnectionFailed: { httpStatusCode: 403 } },
        NOT_IN_PLAN,
      ),
    ).toBe("permission_error");
  });

  it("a refusal Codex reported while still retrying is not retryable once the turn failed", () => {
    const retrying = { class: "permission_error", message: NOT_IN_PLAN, retryable: true };
    expect(settledCodexFailure(retrying)).toEqual({ ...retrying, retryable: false });
    const transient = { class: "transport_error", message: "stream closed", retryable: true };
    expect(settledCodexFailure(transient)).toBe(transient);
  });

  it("keeps usage limits, transport and other provider errors as they were", () => {
    const limited = { responseTooManyFailedAttempts: { httpStatusCode: 429 } };
    expect(codexUsageLimitError("responseTooManyFailedAttempts", limited)).toBe(true);
    expect(codexTerminalFailure("responseTooManyFailedAttempts", limited, "429")).toEqual({
      class: "usage_limit",
    });
    expect(
      codexTerminalFailure(
        "responseTooManyFailedAttempts",
        { responseTooManyFailedAttempts: { httpStatusCode: 500 } },
        "unexpected status 500",
      ),
    ).toEqual({ class: "provider_error" });
    expect(
      codexRetryFailureClass(
        "responseStreamDisconnected",
        { responseStreamDisconnected: { httpStatusCode: 502 } },
        "stream closed",
      ),
    ).toBe("transport_error");
  });
});
