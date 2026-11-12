import { assert, describe, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Logger from "effect/Logger";
import * as TestClock from "effect/testing/TestClock";

import { discoverWithRetries, makeLiveShellProbes } from "./loginShellRetry.ts";

const gone = Effect.succeed(true);

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
      const fiber = yield* discoverWithRetries(attempt, "darwin", gone).pipe(
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
      const fiber = yield* discoverWithRetries(attempt, "linux", gone).pipe(
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
      assert.isFalse(yield* discoverWithRetries(attempt, "win32", gone));
      assert.equal(startedAt.length, 1);
    }),
  );

  it.effect("never probes again while an earlier probe's process is not known to be gone", () =>
    Effect.gen(function* () {
      const { startedAt, attempt } = attemptsThat(2);
      const fiber = yield* discoverWithRetries(attempt, "darwin", Effect.succeed(false)).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1 day");
      assert.isFalse(yield* Fiber.join(fiber));
      assert.equal(startedAt.length, 1);
    }).pipe(Effect.provide(Logger.layer([]))),
  );

  it.effect("probes again when the earlier process is gone by the time the next probe is due", () =>
    Effect.gen(function* () {
      const { startedAt, attempt } = attemptsThat(2);
      const start = yield* Clock.currentTimeMillis;
      const goneAfter20Seconds = Clock.currentTimeMillis.pipe(
        Effect.map((now) => now - start >= 20_000),
      );
      const fiber = yield* discoverWithRetries(attempt, "darwin", goneAfter20Seconds).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* TestClock.adjust("1 day");
      assert.isTrue(yield* Fiber.join(fiber));
      assert.deepEqual(
        startedAt.map((at) => at - start),
        [0, 30_000],
      );
    }),
  );

  it.effect("counts a probe as live until it has finished, cleanup included", () =>
    Effect.gen(function* () {
      const probes = yield* makeLiveShellProbes;
      const exited = yield* Deferred.make<void>();
      assert.isTrue(yield* probes.allGone);
      const probe = yield* probes
        .track(Effect.never.pipe(Effect.ensuring(Deferred.await(exited))))
        .pipe(Effect.forkChild({ startImmediately: true }));
      assert.isFalse(yield* probes.allGone);

      // Timed out and killed, but the process has not exited yet.
      const killing = yield* Fiber.interrupt(probe).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      assert.isFalse(yield* probes.allGone);
      yield* Deferred.succeed(exited, undefined);
      yield* Fiber.join(killing);
      assert.isTrue(yield* probes.allGone);
    }),
  );
});
