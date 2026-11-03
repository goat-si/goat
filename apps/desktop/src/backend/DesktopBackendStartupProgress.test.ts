import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import { makeStartupProgress } from "./DesktopBackendStartupProgress.ts";

it.effect("progress delays startup warning until sixty seconds of silence", () =>
  Effect.gen(function* () {
    const progress = yield* makeStartupProgress();
    const reports = yield* Queue.unbounded<string>();
    const watcher = yield* progress
      .watch((reason) => Queue.offer(reports, reason).pipe(Effect.asVoid))
      .pipe(Effect.forkChild({ startImmediately: true }));
    for (let i = 0; i < 12; i++) {
      yield* TestClock.adjust("15 seconds");
      yield* progress.activity;
    }
    assert.equal(yield* Queue.size(reports), 0);
    yield* TestClock.adjust("60 seconds");
    assert.equal(yield* Queue.take(reports), "The server printed nothing for 60 seconds.");
    yield* Fiber.join(watcher);
    yield* TestClock.adjust("10 minutes");
    assert.equal(yield* Queue.size(reports), 0);
  }),
);

it.effect("a chatty server reports once at the ten minute ceiling", () =>
  Effect.gen(function* () {
    const progress = yield* makeStartupProgress();
    const reports = yield* Queue.unbounded<string>();
    const watcher = yield* progress
      .watch((reason) => Queue.offer(reports, reason).pipe(Effect.asVoid))
      .pipe(Effect.forkChild({ startImmediately: true }));
    for (let i = 0; i < 40; i++) {
      yield* TestClock.adjust("15 seconds");
      yield* progress.activity;
    }
    yield* Fiber.join(watcher);
    assert.equal(yield* Queue.take(reports), "The server was not ready after 10 minutes.");
    assert.equal(yield* Queue.size(reports), 0);
  }),
);

it.effect.each(["ready", "exit"] as const)("%s cancels startup stall reporting", (outcome) =>
  Effect.gen(function* () {
    const progress = yield* makeStartupProgress();
    const reports = yield* Queue.unbounded<string>();
    const watcher = yield* progress
      .watch((reason) => Queue.offer(reports, reason).pipe(Effect.asVoid))
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("59 seconds");
    if (outcome === "ready") yield* progress.ready;
    else yield* Fiber.interrupt(watcher);
    yield* TestClock.adjust("1 minute");
    yield* Fiber.await(watcher);
    assert.equal(yield* Queue.size(reports), 0);
  }),
);

it.effect("ready at ninety seconds after output cancels the startup warning", () =>
  Effect.gen(function* () {
    const progress = yield* makeStartupProgress();
    const reports = yield* Queue.unbounded<string>();
    const watcher = yield* progress
      .watch((reason) => Queue.offer(reports, reason).pipe(Effect.asVoid))
      .pipe(Effect.forkChild({ startImmediately: true }));
    yield* TestClock.adjust("45 seconds");
    yield* progress.activity;
    yield* TestClock.adjust("45 seconds");
    yield* progress.ready;
    yield* Fiber.join(watcher);
    yield* TestClock.adjust("10 minutes");
    assert.equal(yield* Queue.size(reports), 0);
  }),
);

it.effect("readiness at the stall deadline wins over the warning", () =>
  Effect.gen(function* () {
    const progress = yield* makeStartupProgress();
    const reports = yield* Queue.unbounded<string>();
    const clock = yield* Clock.Clock;
    const deadlineClock = {
      currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
      currentTimeMillis: clock.currentTimeMillis,
      currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
      currentTimeNanos: clock.currentTimeNanos,
      monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
      monotonicTimeNanos: clock.monotonicTimeNanos.pipe(
        Effect.tap((now) => (now === 60_000_000_000n ? progress.ready : Effect.void)),
      ),
      sleep: clock.sleep.bind(clock),
    } satisfies Clock.Clock;
    const watcher = yield* progress
      .watch((reason) => Queue.offer(reports, reason).pipe(Effect.asVoid))
      .pipe(
        Effect.provideService(Clock.Clock, deadlineClock),
        Effect.forkChild({ startImmediately: true }),
      );
    yield* TestClock.adjust("60 seconds");
    yield* Fiber.join(watcher);
    assert.equal(yield* Queue.size(reports), 0);
  }),
);
