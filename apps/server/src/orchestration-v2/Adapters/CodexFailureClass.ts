import type * as CodexSchema from "effect-codex-app-server/schema";

type CodexErrorInfo = CodexSchema.ServerNotification__CodexErrorInfo;

/** The upstream HTTP status Codex forwards on its connection and stream error variants. */
function codexHttpStatus(errorInfo: CodexErrorInfo | null | undefined): number | null {
  if (typeof errorInfo !== "object" || errorInfo === null) return null;
  // Codex 0.164 accepts unknown error variants as arbitrary JSON, so the
  // nested value is only trusted once it has the known shape.
  for (const value of Object.values(errorInfo)) {
    if (
      typeof value === "object" &&
      value !== null &&
      "httpStatusCode" in value &&
      typeof value.httpStatusCode === "number"
    )
      return value.httpStatusCode;
  }
  return null;
}

/**
 * Retry exhaustion only says why it failed through the last attempt's HTTP
 * status. Exhaustion on 429 is a usage or rate limit, so it keeps the Limited
 * state and resume controls; other statuses stay provider or transport errors.
 */
export function codexExhaustionHttpStatus(
  errorInfo: CodexErrorInfo | null | undefined,
): number | null {
  return typeof errorInfo === "object" &&
    errorInfo !== null &&
    "responseTooManyFailedAttempts" in errorInfo
    ? codexHttpStatus(errorInfo)
    : null;
}

export function codexUsageLimitError(
  code: string | null,
  errorInfo: CodexErrorInfo | null | undefined,
): boolean {
  return (
    code === "usageLimitExceeded" ||
    code === "rateLimitExceeded" ||
    codexExhaustionHttpStatus(errorInfo) === 429
  );
}

// OpenCodex and other routers pass the upstream refusal through in the message, e.g.
// "Provider error 403: {...MODEL_NOT_IN_PLAN: ...}" (#1205).
const ENTITLEMENT_REFUSAL = /\bMODEL_NOT_IN_PLAN\b|\b403 Forbidden\b|\bProvider error 403\b/;

/**
 * A route that refuses the model for this account (HTTP 403, a plan that lacks it). Retrying the
 * same route cannot succeed, so it is a permission error that fallback chains treat as an
 * unavailable step.
 */
function codexEntitlementRefusal(
  errorInfo: CodexErrorInfo | null | undefined,
  message: string | null | undefined,
): boolean {
  return (
    codexHttpStatus(errorInfo) === 403 ||
    (message !== null && message !== undefined && ENTITLEMENT_REFUSAL.test(message))
  );
}

/** The class of a failure Codex reports as final: a turn's terminal error. */
export function codexTerminalFailure(
  code: string | null,
  errorInfo: CodexErrorInfo | null | undefined,
  message: string | null | undefined,
): {
  readonly class: "usage_limit" | "permission_error" | "provider_error";
  readonly retryable?: false;
} {
  if (codexUsageLimitError(code, errorInfo)) return { class: "usage_limit" };
  if (codexEntitlementRefusal(errorInfo, message))
    return { class: "permission_error", retryable: false };
  return { class: "provider_error" };
}

/** The class of a failure Codex is still retrying. */
export function codexRetryFailureClass(
  code: string | null,
  errorInfo: CodexErrorInfo | null | undefined,
  message: string | null | undefined,
): "usage_limit" | "permission_error" | "transport_error" | "provider_error" {
  if (codexUsageLimitError(code, errorInfo)) return "usage_limit";
  if (codexEntitlementRefusal(errorInfo, message)) return "permission_error";
  return code?.startsWith("http") === true || code?.startsWith("responseStream") === true
    ? "transport_error"
    : "provider_error";
}
