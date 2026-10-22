import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type { RelayManagedEndpointRuntimeConfig } from "@goat/contracts/relay";
import { RelayRequestError } from "./relayResponse.ts";

import {
  makeManagedTunnelRecovery,
  retryDesiredLinkReconcile,
  retryManagedTunnelRegistration,
} from "./managedTunnelStartup.ts";

describe("retryManagedTunnelRegistration", () => {
  it.effect("does not fall back or retry when registration is permanently rejected", () =>
    Effect.gen(function* () {
      let attempts = 0;
      let fallbacks = 0;
      const error = yield* Effect.flip(
        retryManagedTunnelRegistration(
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail("not authorized");
          }),
          () => false,
          Effect.sync(() => {
            fallbacks += 1;
          }),
        ),
      );
      expect(error).toBe("not authorized");
      expect(attempts).toBe(1);
      expect(fallbacks).toBe(0);
    }),
  );
});

const recoveryConfig: RelayManagedEndpointRuntimeConfig = {
  providerKind: "t3_relay",
  connectorToken: "test-token",
};

describe("managed tunnel recovery backoff", () => {
  it.effect("runs the first request immediately and doubles repeated-request cooldowns", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const recover = yield* makeManagedTunnelRecovery({
        recover: () => Effect.sync(() => ++attempts),
        isRetryable: () => false,
      });
      yield* recover(recoveryConfig);
      expect(attempts).toBe(1);
      const second = yield* Effect.forkChild(recover(recoveryConfig));
      yield* TestClock.adjust("3 minutes");
      expect(attempts).toBe(1);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(second);
      expect(attempts).toBe(2);
      const third = yield* Effect.forkChild(recover(recoveryConfig));
      yield* TestClock.adjust("7 minutes");
      expect(attempts).toBe(2);
      yield* TestClock.adjust("1 minute");
      yield* Fiber.join(third);
      expect(attempts).toBe(3);
      yield* TestClock.adjust("18 minutes");
      yield* recover(recoveryConfig);
      expect(attempts).toBe(4);
    }),
  );

  it.effect("honors relay Retry-After during recovery retries", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const recover = yield* makeManagedTunnelRecovery({
        recover: () =>
          Effect.suspend(() =>
            ++attempts === 1
              ? Effect.fail(
                  new RelayRequestError({
                    rejection: "unavailable",
                    description: "relay offline",
                    retryAfterMillis: 300_000,
                  }),
                )
              : Effect.succeed(true),
          ),
        isRetryable: () => true,
      });
      const fiber = yield* Effect.forkChild(recover(recoveryConfig));
      yield* TestClock.adjust("4 minutes");
      expect(attempts).toBe(1);
      yield* TestClock.adjust("1 minute");
      expect(yield* Fiber.join(fiber)).toBe(true);
      expect(attempts).toBe(2);
    }),
  );
});

describe("desired link reconciliation retry window", () => {
  it.effect(
    "keeps retrying an unavailable relay after the window without ignoring Retry-After",
    () =>
      Effect.gen(function* () {
        let attempts = 0;
        let warnings = 0;
        const exhausted = yield* Deferred.make<void>();
        const fiber = yield* Effect.forkChild(
          retryDesiredLinkReconcile(
            Effect.suspend(() =>
              ++attempts <= 2
                ? Effect.fail(
                    new RelayRequestError({
                      rejection: "unavailable",
                      description: "relay offline",
                      retryAfterMillis: 900_000,
                    }),
                  )
                : Effect.succeed("managed"),
            ),
            () => true,
            () =>
              Effect.sync(() => {
                warnings += 1;
              }).pipe(Effect.andThen(Deferred.succeed(exhausted, undefined)), Effect.asVoid),
          ),
        );
        yield* Deferred.await(exhausted);
        expect(attempts).toBe(1);
        yield* TestClock.adjust("14 minutes");
        expect(attempts).toBe(1);
        yield* TestClock.adjust("1 minute");
        expect(attempts).toBe(2);
        yield* TestClock.adjust("15 minutes");
        expect(yield* Fiber.join(fiber)).toBe("managed");
        expect(attempts).toBe(3);
        expect(warnings).toBe(1);
      }),
  );

  it.effect("stops retrying a local runtime failure at the window", () =>
    Effect.gen(function* () {
      let attempts = 0;
      let warnings = 0;
      const failure = {
        _tag: "LocalRuntimeError",
        cause: new RelayRequestError({
          rejection: "unavailable",
          description: "retry hint",
          retryAfterMillis: 900_000,
        }),
      };
      const fiber = yield* Effect.forkChild(
        retryDesiredLinkReconcile(
          Effect.suspend(() => {
            attempts += 1;
            return Effect.fail(failure);
          }),
          () => true,
          () =>
            Effect.sync(() => {
              warnings += 1;
            }),
        ).pipe(Effect.flip),
      );
      yield* TestClock.adjust("15 minutes");
      expect(yield* Fiber.join(fiber)).toBe(failure);
      expect(attempts).toBe(1);
      expect(warnings).toBe(0);
    }),
  );
});
