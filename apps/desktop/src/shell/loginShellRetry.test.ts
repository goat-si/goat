import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

import { discoverWithRetries } from "./loginShellRetry.ts";

const attemptsThat = (succeedOn: number) => {
  const startedAt: number[] = [];
  const attempt = Effect.gen(function* () {
    startedAt.push(yield* Clock.currentTimeMillis);
    return startedAt.length === succeedOn;
  });
  return { startedAt, attempt };
};

describe("login shell discovery retries", () => {
  it.effect("gives up after three more probes, 30 seconds, 2 minutes and 10 minutes apart", () =>
    Effect.gen(function* () {
      const { startedAt, attempt } = attemptsThat(Number.POSITIVE_INFINITY);
      const start = yield* Clock.currentTimeMillis;
      const fiber = yield* discoverWithRetries(attempt, "darwin").pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1 day");
      assert.isFalse(yield* Fiber.join(fiber));
      assert.deepEqual(
        startedAt.map((at) => at - start),
        [0, 30_000, 150_000, 750_000],
      );
    }).pipe(Effect.provide(Logger.layer([]))),
  );

  it.effect("stops probing at the first success", () =>
    Effect.gen(function* () {
      const { startedAt, attempt } = attemptsThat(2);
      const fiber = yield* discoverWithRetries(attempt, "linux").pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1 day");
      assert.isTrue(yield* Fiber.join(fiber));
      assert.equal(startedAt.length, 2);
    }),
  );

  it.effect("keeps Windows at its single probe", () =>
    Effect.gen(function* () {
      const { startedAt, attempt } = attemptsThat(Number.POSITIVE_INFINITY);
      assert.isFalse(yield* discoverWithRetries(attempt, "win32"));
      assert.equal(startedAt.length, 1);
    }),
  );
});
