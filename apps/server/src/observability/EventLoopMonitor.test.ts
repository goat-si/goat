import { it } from "@effect/vitest";
import { assert, describe, vi } from "vite-plus/test";
import * as NodePerfHooks from "node:perf_hooks";
import * as SqlClient from "effect/sql/SqlClient";
import * as SqliteClient from "@goat/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import * as EventLoopMonitor from "./EventLoopMonitor.ts";

const ms = (value: number) => value * 1e6;

// Node reports a stall of S as a gap of up to S + 1 s, the histogram resolution.
const stalled: EventLoopMonitor.EventLoopReadings = {
  delayMaxNs: ms(5_950),
  activeMs: 6_200,
  utilization: 0.176,
  usage: {
    userCPUTime: 310_400,
    systemCPUTime: 95_600,
    majorPageFault: 8_412,
    minorPageFault: 20_031,
    involuntaryContextSwitches: 57,
  },
  rssBytes: 1536 * 1024 * 1024,
  heapUsedBytes: 512 * 1024 * 1024,
  elapsedMs: 30_000,
  loadAverage: 219.43,
  cpuCount: 18,
};

describe("EventLoopMonitor", () => {
  it("ignores delay the loop spent idle, such as a system sleep", () => {
    const asleep: EventLoopMonitor.EventLoopReadings = {
      ...stalled,
      delayMaxNs: ms(600_000),
      activeMs: 900,
    };
    assert.isUndefined(EventLoopMonitor.stallMs(asleep));
    assert.strictEqual(EventLoopMonitor.stallMs({ ...asleep, activeMs: 600_000 }), 599_000);
  });
});

const stallLog = { filePath: "/unused/stalls.ndjson", maxBytes: 262144 };
const runtimeStall = { ...stalled, delayMaxNs: ms(7_000), activeMs: 7_000 };

it.effect.each([
  { label: "stalled", readings: runtimeStall },
  { label: "healthy", readings: { ...stalled, delayMaxNs: ms(1_000), activeMs: 1 } },
] as const)(
  "persists the $label startup sample without a reconnect notice",
  ({ label, readings }) =>
    Effect.gen(function* () {
      const lines = yield* Queue.unbounded<string>();
      let first = true;
      yield* Effect.gen(function* () {
        const monitor = yield* EventLoopMonitor.EventLoopMonitor;
        yield* TestClock.adjust("30 seconds");
        assert.equal(yield* Queue.size(lines), 1, "startup evidence must be persisted");
        const line = yield* Queue.take(lines);
        assert.include(line, '"phase":"startup"');
        if (label === "healthy") assert.include(line, '"delayMaxMs":0');
        assert.isUndefined(yield* monitor.latestStall);
        assert.isUndefined(yield* monitor.latestNoticeableStall);
      }).pipe(
        Effect.provide(
          EventLoopMonitor.layerWith(
            Effect.succeed(
              Effect.sync(() => {
                const next = first ? readings : { ...readings, delayMaxNs: ms(1_000), activeMs: 0 };
                first = false;
                return next;
              }),
            ),
            stallLog,
            (line) => Queue.offer(lines, line).pipe(Effect.asVoid),
          ),
        ),
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("publishes stall state and serves reconnects while its sink is blocked", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    yield* Effect.gen(function* () {
      const monitor = yield* EventLoopMonitor.EventLoopMonitor;
      yield* TestClock.adjust("60 seconds");
      assert.isTrue(yield* Deferred.isDone(entered));
      assert.equal((yield* monitor.latestStall)?.delayMs, 6_000);
      const reconnect = yield* monitor.latestNoticeableStall.pipe(Effect.forkChild);
      yield* TestClock.adjust(0);
      assert.isDefined(reconnect.pollUnsafe(), "reconnect sampling must not await disk");
      assert.deepEqual(yield* Fiber.join(reconnect), {
        detectedAt: "1970-01-01T00:01:00.000Z",
        durationMs: 6_000,
        loadAverage: 219.4,
        cpuCount: 18,
      });
    }).pipe(
      Effect.ensuring(Deferred.succeed(release, undefined)),
      Effect.provide(
        EventLoopMonitor.layerWith(Effect.succeed(Effect.succeed(runtimeStall)), stallLog, () =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("bounds pending stall records and reports rejected evidence", () =>
  Effect.gen(function* () {
    const release = yield* Deferred.make<void>();
    const written = yield* Queue.unbounded<string>();
    const flushed = yield* Deferred.make<void>();
    let completed = 0;
    let samples = 0;
    yield* Effect.gen(function* () {
      const monitor = yield* EventLoopMonitor.EventLoopMonitor;
      for (let index = 0; index < 19; index++) yield* TestClock.adjust("30 seconds");
      assert.equal(samples, 19, "sampling must continue under disk pressure");
      yield* Deferred.succeed(release, undefined);
      yield* Deferred.await(flushed);
      assert.equal(yield* Queue.size(written), 17, "one active write plus sixteen queued");
      yield* monitor.latestNoticeableStall;
      yield* TestClock.adjust(0);
      for (let index = 0; index < 17; index++) yield* Queue.take(written);
      assert.include(yield* Queue.take(written), '"droppedStallRecords":2');
    }).pipe(
      Effect.ensuring(Deferred.succeed(release, undefined)),
      Effect.provide(
        EventLoopMonitor.layerWith(
          Effect.succeed(
            Effect.sync(() => {
              samples++;
              return runtimeStall;
            }),
          ),
          stallLog,
          (line) =>
            Deferred.await(release).pipe(
              Effect.andThen(Queue.offer(written, line)),
              Effect.andThen(
                Effect.suspend(() =>
                  ++completed === 17
                    ? Deferred.succeed(flushed, undefined).pipe(Effect.asVoid)
                    : Effect.void,
                ),
              ),
              Effect.asVoid,
            ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("continues recording after sink failure and expires runtime notices", () =>
  Effect.gen(function* () {
    const lines = yield* Queue.unbounded<string>();
    let writes = 0;
    let readings = runtimeStall;
    yield* Effect.gen(function* () {
      const monitor = yield* EventLoopMonitor.EventLoopMonitor;
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Queue.size(lines), 1);
      assert.include(yield* Queue.take(lines), '"phase":"runtime"');
      readings = { ...runtimeStall, delayMaxNs: ms(1_000), activeMs: 0 };
      assert.isDefined(yield* monitor.latestNoticeableStall);
      yield* TestClock.adjust("5 minutes");
      assert.isDefined(yield* monitor.latestNoticeableStall);
      yield* TestClock.adjust(1);
      assert.isUndefined(yield* monitor.latestNoticeableStall);
    }).pipe(
      Effect.provide(
        EventLoopMonitor.layerWith(Effect.succeed(Effect.sync(() => readings)), stallLog, (line) =>
          Effect.suspend(() =>
            ++writes === 1
              ? Effect.fail("injected sink failure")
              : Queue.offer(lines, line).pipe(Effect.asVoid),
          ),
        ),
      ),
    );
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("correlates native writer successes and failures with local stall evidence", () =>
  Effect.gen(function* () {
    const lines = yield* Queue.unbounded<string>();
    const sql = yield* SqlClient.SqlClient;
    let clock = 0;
    yield* Effect.gen(function* () {
      using _now = vi.spyOn(Date, "now").mockReturnValue(30_000);
      using _nativeClock = vi
        .spyOn(NodePerfHooks.performance, "now")
        .mockImplementation(() => (clock += 75));
      yield* sql`SELECT 1 AS native_success`.pipe(Effect.withSpan("test.nativeWriter"));
      yield* sql`SELECT * FROM native_failure_missing_table`.pipe(
        Effect.withSpan("test.nativeWriterFailure"),
        Effect.exit,
      );
      yield* sql`SELECT abs(-9223372036854775808)`.pipe(
        Effect.withSpan("test.nativeWriterExecuteFailure"),
        Effect.exit,
      );
    });
    yield* Effect.gen(function* () {
      const monitor = yield* EventLoopMonitor.EventLoopMonitor;
      yield* TestClock.adjust("30 seconds");
      assert.equal(yield* Queue.size(lines), 1, "SQL evidence accompanies the startup record");
      const startup = yield* Queue.take(lines);
      assert.include(startup, '"phase":"startup"');
      assert.include(startup, '"owner":"test.nativeWriter"');
      assert.include(startup, '"owner":"test.nativeWriterFailure"');
      assert.include(startup, '"owner":"test.nativeWriterExecuteFailure"');
      assert.include(startup, '"nativeMs":75');
      assert.notInclude(startup, "native_failure_missing_table");
      yield* TestClock.adjust("30 seconds");
      const runtime = yield* Queue.take(lines);
      assert.include(runtime, '"phase":"runtime"');
      assert.include(runtime, '"connection":"writer"');
      assert.include(runtime, '"operation":"prepare"');
      assert.include(runtime, '"operation":"execute"');
      assert.deepEqual(Object.keys((yield* monitor.latestNoticeableStall) ?? {}).sort(), [
        "cpuCount",
        "detectedAt",
        "durationMs",
        "loadAverage",
      ]);
    }).pipe(
      Effect.provide(
        EventLoopMonitor.layerWith(Effect.succeed(Effect.succeed(runtimeStall)), stallLog, (line) =>
          Queue.offer(lines, line).pipe(Effect.asVoid),
        ),
      ),
    );
  }).pipe(
    Effect.scoped,
    Effect.provide(SqliteClient.layer({ filename: ":memory:" })),
    Effect.provide(NodeServices.layer),
  ),
);
