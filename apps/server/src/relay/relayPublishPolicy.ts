import { RelayProtectedError } from "@goat/contracts/relay";
import * as Schema from "effect/Schema";
import * as HttpClientError from "effect/http/HttpClientError";

const isRelayError = Schema.is(RelayProtectedError);
export function publishFailurePolicy(
  error: unknown,
  nowMillis: number,
): { readonly blocked: boolean; readonly retryAfterMillis?: number } {
  if (isRelayError(error)) {
    if (error._tag === "RelayRateLimitExceededError")
      return { blocked: false, retryAfterMillis: error.retryAfterSeconds * 1000 };
    return {
      blocked: [
        "RelayAccountAccessDeniedError",
        "RelayAccountEpochStaleError",
        "RelayEnvironmentRelinkRequiredError",
        "RelayEnvironmentOwnerConflictError",
        "RelayEnvironmentOwnerMismatchError",
        "RelayAuthInvalidError",
      ].includes(error._tag),
    };
  }
  if (HttpClientError.isHttpClientError(error) && error.response) {
    const status = error.response.status;
    if (status === 401 || status === 403 || status === 409) return { blocked: true };
    const raw = error.response.headers["retry-after"]?.trim();
    if (status === 429 && raw) {
      const delay = /^\d+$/.test(raw)
        ? Number(raw) * 1000
        : /^[+-]?\d/.test(raw)
          ? Number.NaN
          : Date.parse(raw) - nowMillis;
      if (Number.isFinite(delay) && delay >= 0) return { blocked: false, retryAfterMillis: delay };
    }
  }
  return { blocked: false };
}
export class RelayPublishCooldown extends Schema.TaggedError<RelayPublishCooldown>()(
  "RelayPublishCooldown",
  { retryAt: Schema.Number },
) {}
