import type { RelayRateLimitOperation } from "@goat/contracts/relayErrors";
import {
  RelayRateLimitExceededError,
  RelayAuthorizationUnavailableError,
} from "@goat/contracts/relayErrors";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type RateLimitError = RelayRateLimitExceededError | RelayAuthorizationUnavailableError;
export class RelayRateLimits extends Context.Service<
  RelayRateLimits,
  {
    readonly charge: (input: {
      readonly userId: string;
      readonly operation: RelayRateLimitOperation;
      readonly environmentId?: string;
      readonly environmentPublicKey?: string;
    }) => Effect.Effect<void, RateLimitError>;
  }
>()("goat-relay/accounts/RelayRateLimits") {}

export const enforceRateResult = (
  operation: RelayRateLimitOperation,
  result: { readonly allowed: boolean; readonly retryAfterSeconds: number },
) =>
  result.allowed
    ? Effect.void
    : Effect.fail(
        new RelayRateLimitExceededError({
          code: "rate_limit_exceeded",
          operation,
          retryAfterSeconds: result.retryAfterSeconds,
          traceId: "relay",
        }),
      );
