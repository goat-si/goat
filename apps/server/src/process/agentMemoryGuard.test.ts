import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import {
  makeAgentMemoryGuard,
  parseProcessTable,
  treeOf,
  resolveAgentMemoryLimitBytes,
} from "./agentMemoryGuard.ts";

const root = { pid: 10, ppid: 1, pgid: 10, rssBytes: 60, zombie: false };
const descendant = { pid: 11, ppid: 10, pgid: 11, rssBytes: 50, zombie: false };

const fixture = (
  options: { shared?: boolean; leader?: boolean; running?: boolean; groupThrows?: boolean } = {},
) =>
  Effect.gen(function* () {
    const signals: number[] = [];
    let running = options.running ?? true;
    let limit: number | null = 100;
    let samples = 0;
    let failed = false;
    let rows = [{ ...root, pgid: options.leader === false ? 1 : 10 }, descendant];
    let beforeCheck: Effect.Effect<void> = Effect.void;
    const guard = yield* makeAgentMemoryGuard({
      sample: Effect.suspend(() => {
        samples++;
        if (failed) return Effect.fail("sample failed");
        return Effect.succeed(rows);
      }),
      limitBytes: Effect.sync(() => limit),
      signal: (pid) => {
        signals.push(pid);
        if (pid < 0 && options.groupThrows) throw new Error("group failed");
      },
      inCheckPhase: (block) => beforeCheck.pipe(Effect.flatMap(() => Effect.sync(block))),
    });
    const process = { pid: 10, isRunning: () => running };
    return {
      guard,
      process,
      signals,
      watch: () => guard.watch({ process, threadId: "thread", shared: options.shared }),
      tick: () => TestClock.adjust("30 seconds"),
      setRunning: (value: boolean) => {
        running = value;
      },
      setLimit: (value: number | null) => {
        limit = value;
      },
      setRows: (value: typeof rows) => {
        rows = value;
      },
      setFailed: (value: boolean) => {
        failed = value;
      },
      setBeforeCheck: (value: Effect.Effect<void>) => {
        beforeCheck = value;
      },
      samples: () => samples,
    };
  });

describe("agent memory guard", () => {
  it.effect("kills an owned leader and marks only its thread", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.watch();
      yield* f.tick();
      expect(f.signals).toEqual([10, -10]);
      expect(yield* f.guard.oomKilled("thread")).toBe(true);
      expect(yield* f.guard.oomKilled("other")).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("signals only the root when it is not a group leader", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ leader: false });
      yield* f.watch();
      yield* f.tick();
      expect(f.signals).toEqual([10]);
    }).pipe(Effect.scoped),
  );

  it.effect("forgets a reaped child without signalling or marking", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.watch();
      f.setRunning(false);
      yield* f.tick();
      f.setRunning(true);
      yield* f.tick();
      expect(f.signals).toEqual([]);
      expect(yield* f.guard.oomKilled("thread")).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("counts a setsid descendant without signalling it", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.watch();
      yield* f.tick();
      expect(f.signals).toEqual([10, -10]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not attribute a shared process kill", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ shared: true });
      yield* f.watch();
      yield* f.tick();
      expect(f.signals).toEqual([10, -10]);
      expect(yield* f.guard.oomKilled("thread")).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("does not mark a cleared generation", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.watch();
      yield* f.guard.clear("thread");
      yield* f.tick();
      expect(f.signals).toEqual([10, -10]);
      expect(yield* f.guard.oomKilled("thread")).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("skips sampling while empty or disabled and resumes existing watches", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.tick();
      f.setLimit(null);
      yield* f.watch();
      yield* f.tick();
      expect(f.samples()).toBe(0);
      f.setLimit(100);
      yield* f.tick();
      expect(f.samples()).toBe(1);
      expect(f.signals).toEqual([10, -10]);
    }).pipe(Effect.scoped),
  );

  it.effect("skips a failed sample and recovers on the next tick", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.watch();
      f.setFailed(true);
      yield* f.tick();
      expect(f.signals).toEqual([]);
      f.setFailed(false);
      yield* f.tick();
      expect(f.signals).toEqual([10, -10]);
    }).pipe(Effect.scoped),
  );

  it.effect("continues sampling after a defective tick", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.watch();
      f.setBeforeCheck(Effect.die(new Error("check failed")));
      yield* f.tick();
      expect(f.samples()).toBe(1);
      f.setBeforeCheck(Effect.void);
      yield* f.tick();
      expect(f.samples()).toBe(2);
      expect(f.signals).toEqual([10, -10]);
    }).pipe(Effect.scoped),
  );

  it.effect("does not signal a root absent from the snapshot", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.watch();
      f.setRows([descendant]);
      yield* f.tick();
      expect(f.signals).toEqual([]);
    }).pipe(Effect.scoped),
  );

  it.effect("retains the OOM mark when group signalling fails", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ groupThrows: true });
      yield* f.watch();
      yield* f.tick();
      expect(f.signals).toEqual([10, -10]);
      expect(yield* f.guard.oomKilled("thread")).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("does not signal or remove a replacement registration for the same pid", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      yield* f.watch();
      f.setBeforeCheck(f.guard.watch({ process: f.process, threadId: "new" }));
      yield* f.tick();
      expect(f.signals).toEqual([]);
      f.setBeforeCheck(Effect.void);
      yield* f.tick();
      expect(f.signals).toEqual([10, -10]);
      expect(yield* f.guard.oomKilled("new")).toBe(true);
    }).pipe(Effect.scoped),
  );

  it.effect("bounds watched processes and evicts the oldest OOM marks", () =>
    Effect.gen(function* () {
      const signals: number[] = [];
      let rows = Array.from({ length: 1001 }, (_, index) => ({
        pid: index + 10,
        ppid: 1,
        pgid: 1,
        rssBytes: 101,
        zombie: false,
      }));
      const guard = yield* makeAgentMemoryGuard({
        sample: Effect.sync(() => rows),
        limitBytes: Effect.succeed(100),
        signal: (pid) => {
          signals.push(pid);
        },
        inCheckPhase: (block) => Effect.sync(block),
      });
      for (let index = 0; index < 1001; index++) {
        yield* guard.watch({
          process: { pid: index + 10, isRunning: () => true },
          threadId: `thread-${index}`,
        });
      }
      expect(guard.trackingCounts()).toEqual({ watched: 1000, generations: 1000, marked: 0 });
      yield* TestClock.adjust("30 seconds");
      expect(guard.trackingCounts()).toEqual({ watched: 0, generations: 1000, marked: 1000 });
      expect(signals.length).toBe(1000);
      expect(signals).not.toContain(10);
      expect(yield* guard.oomKilled("thread-1")).toBe(true);
      rows = [{ pid: 2000, ppid: 1, pgid: 1, rssBytes: 101, zombie: false }];
      yield* guard.watch({ process: { pid: 2000, isRunning: () => true }, threadId: "latest" });
      yield* TestClock.adjust("30 seconds");
      expect(yield* guard.oomKilled("thread-1")).toBe(false);
      expect(yield* guard.oomKilled("latest")).toBe(true);
      expect(guard.trackingCounts()).toEqual({ watched: 0, generations: 1000, marked: 1000 });
      yield* guard.clear("latest");
      expect(guard.trackingCounts()).toEqual({ watched: 0, generations: 999, marked: 999 });
    }).pipe(Effect.scoped),
  );

  it.effect("keeps old registrations from marking a newer session after generation eviction", () =>
    Effect.gen(function* () {
      const signals: number[] = [];
      const guard = yield* makeAgentMemoryGuard({
        sample: Effect.succeed([{ ...root, rssBytes: 101 }]),
        limitBytes: Effect.succeed(100),
        signal: (pid) => {
          signals.push(pid);
        },
        inCheckPhase: (block) => Effect.sync(block),
      });
      yield* guard.watch({ process: { pid: 10, isRunning: () => true }, threadId: "thread" });
      yield* guard.clear("thread");
      for (let index = 0; index < 1001; index++) yield* guard.clear(`other-${index}`);
      yield* guard.watch({ process: { pid: 12, isRunning: () => true }, threadId: "thread" });
      yield* TestClock.adjust("30 seconds");
      expect(signals).toEqual([10, -10]);
      expect(yield* guard.oomKilled("thread")).toBe(false);
    }).pipe(Effect.scoped),
  );

  it.effect("does not apply an earlier process snapshot to a newly registered child", () =>
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const signals: number[] = [];
      const guard = yield* makeAgentMemoryGuard({
        sample: Deferred.succeed(started, undefined).pipe(
          Effect.andThen(Deferred.await(release)),
          Effect.as([{ ...root, rssBytes: 101 }]),
        ),
        limitBytes: Effect.succeed(100),
        signal: (pid) => {
          signals.push(pid);
        },
        inCheckPhase: (block) => Effect.sync(block),
      });
      yield* guard.watch({ process: { pid: 99, isRunning: () => true }, threadId: "old" });
      const clock = yield* TestClock.adjust("30 seconds").pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* guard.watch({ process: { pid: 10, isRunning: () => true }, threadId: "new" });
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(clock);
      expect(signals).toEqual([]);
      expect(yield* guard.oomKilled("new")).toBe(false);
    }).pipe(Effect.scoped),
  );

  it("resolves the automatic, disabled, and custom memory limits", () => {
    const gib = 1024 ** 3;
    expect(resolveAgentMemoryLimitBytes(null, 16 * gib)).toBe(8 * gib);
    expect(resolveAgentMemoryLimitBytes(null, 128 * gib)).toBe(16 * gib);
    expect(resolveAgentMemoryLimitBytes(0, 16 * gib)).toBeNull();
    expect(resolveAgentMemoryLimitBytes(3, 16 * gib)).toBe(3 * gib);
  });

  it("parses process rows and ignores malformed rows and zombie roots", () => {
    const rows = parseProcessTable("10 1 10 2 S\n11 10 11 3 Z+\ninvalid\n");
    expect(rows).toEqual([
      { ...root, rssBytes: 2048 },
      { ...descendant, rssBytes: 3072, zombie: true },
    ]);
    expect(treeOf(rows, new Map([[10, [rows[1]]]]), 11)).toBeUndefined();
  });
});
