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
    readonly close?: (
      userId: string,
      subjectDigest: string,
    ) => Effect.Effect<void, RelayAuthorizationUnavailableError>;
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
  readonly close?: (key: string) => Effect.Effect<void, HourlyError>;
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
  const close = bindings.close;
  return RelayRateLimits.of({
    ...(close
      ? {
          close: Effect.fn("RelayRateLimits.close")(function* (userId, subjectDigest) {
            const legacy = yield* crypto.digest(
              "SHA-256",
              new TextEncoder().encode(
                [bindings.stage, userId].map((part) => `${part.length}:${part}`).join(""),
              ),
            );
            const legacyKey = Array.from(legacy, (b) => b.toString(16).padStart(2, "0")).join("");
            yield* Effect.all([close(legacyKey), close(subjectDigest)]);
          }, Effect.mapError(() => new RelayAuthorizationUnavailableError({
            code: "authorization_unavailable",
            traceId: "relay",
          }))),
        }
      : {}),
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
      const check: Effect.Effect<
        { readonly allowed: boolean; readonly retryAfterSeconds: number },
        HourlyError | MobileError | PublishError
      > =
        input.operation === "mobile_registration"
          ? bindings
              .mobile(key)
              .pipe(Effect.map((r) => ({ allowed: r.success, retryAfterSeconds: 60 })))
          : input.operation === "activity_publish"
            ? bindings
                .publish(key)
                .pipe(Effect.map((r) => ({ allowed: r.success, retryAfterSeconds: 60 })))
            : bindings.hourly(key, input.operation);
      const result = yield* check.pipe(
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
