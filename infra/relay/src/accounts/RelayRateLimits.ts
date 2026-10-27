import * as Crypto from "effect/Crypto";
import type { HourlyOperation } from "./AccountLimits.ts";
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

export const makeWorkerRateLimits = Effect.fn("RelayRateLimits.makeWorker")(function* <
  HourlyError,
  MobileError,
  PublishError,
>(bindings: {
  readonly stage: string;
  readonly hourly: (
    key: string,
    operation: HourlyOperation,
  ) => Effect.Effect<
    { readonly allowed: boolean; readonly retryAfterSeconds: number },
    HourlyError
  >;
  readonly mobile: (key: string) => Effect.Effect<{ readonly success: boolean }, MobileError>;
  readonly publish: (key: string) => Effect.Effect<{ readonly success: boolean }, PublishError>;
}) {
  const crypto = yield* Crypto.Crypto;
  return RelayRateLimits.of({
    charge: Effect.fn("RelayRateLimits.charge")(function* (input) {
      const key = yield* crypto
        .digest(
          "SHA-256",
          new TextEncoder().encode(
            (input.operation === "activity_publish"
              ? [bindings.stage, input.environmentId ?? "", input.environmentPublicKey ?? ""]
              : [bindings.stage, input.userId]
            )
              .map((part) => `${part.length}:${part}`)
              .join(""),
          ),
        )
        .pipe(
          Effect.map((bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("")),
          Effect.mapError(
            () =>
              new RelayAuthorizationUnavailableError({
                code: "authorization_unavailable",
                traceId: "relay",
              }),
          ),
        );
      const result = yield* (
        input.operation === "mobile_registration" || input.operation === "activity_publish"
          ? (input.operation === "mobile_registration" ? bindings.mobile : bindings.publish)(
              key,
            ).pipe(Effect.map((r) => ({ allowed: r.success, retryAfterSeconds: 60 })))
          : bindings.hourly(key, input.operation)
      ).pipe(
        Effect.catchCause(() =>
          Effect.fail(
            new RelayAuthorizationUnavailableError({
              code: "authorization_unavailable",
              traceId: "relay",
            }),
          ),
        ),
      );
      yield* enforceRateResult(input.operation, result);
    }),
  });
});
