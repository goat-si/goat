import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import {
  type ClaudeProcessRow,
  makeClaudeDescendantSampler,
  parseClaudeProcessTable,
} from "./ClaudeDescendants.ts";

const row = (pid: number, ppid: number, started: string, pgid = pid): ClaudeProcessRow => ({
  pid,
  ppid,
  pgid,
  started,
});

const fakeTable = (initial: ReadonlyArray<ClaudeProcessRow> | undefined) => {
  const state = { rows: initial, reads: 0, killed: [] as Array<number> };
  return {
    state,
    sampler: makeClaudeDescendantSampler({
      readTable: Effect.sync(() => {
        state.reads += 1;
        return Option.fromUndefinedOr(state.rows);
      }),
      interval: "1 second",
      kill: (killed) => void state.killed.push(killed.pid),
    }),
  };
};

it.effect("samples one process table per interval however many CLIs it tracks", () =>
  Effect.gen(function* () {
    const { state, sampler } = fakeTable([]);
    const { track } = yield* sampler;
    const trackers = [track(100), track(200), track(300)];
    yield* TestClock.adjust("3 seconds");
    assert.equal(state.reads, 4);

    for (const tracker of trackers) yield* tracker.stop;
    const afterStop = state.reads;
    yield* TestClock.adjust("10 seconds");
    assert.equal(state.reads, afterStop);
  }),
);

it.effect("stops a job that left the CLI's group once the CLI has exited", () =>
  Effect.gen(function* () {
    const { state, sampler } = fakeTable([row(100, 1, "A"), row(200, 100, "B")]);
    const tracker = (yield* sampler).track(100);
    yield* TestClock.adjust("1 second");
    // The CLI exited; its job was re-parented to launchd.
    state.rows = [row(200, 1, "B"), row(201, 200, "C", 200)];
    yield* tracker.stop;
    assert.deepEqual(state.killed.toSorted(), [200, 201]);
  }),
);

it.effect("never signals a reused pid, the CLI's old pid or this server", () =>
  Effect.gen(function* () {
    const { state, sampler } = fakeTable([
      row(100, 1, "A"),
      row(200, 100, "B"),
      row(process.pid, 100, "S"),
    ]);
    const tracker = (yield* sampler).track(100);
    yield* tracker.refresh;
    // Both pids now belong to other processes: different start times.
    state.rows = [row(100, 1, "X"), row(300, 100, "Y"), row(200, 1, "Z"), row(process.pid, 1, "S")];
    yield* tracker.stop;
    assert.deepEqual(state.killed, []);
  }),
);

it.effect("a process table that cannot be read kills nothing", () =>
  Effect.gen(function* () {
    const { state, sampler } = fakeTable([row(100, 1, "A"), row(200, 100, "B")]);
    const tracker = (yield* sampler).track(100);
    yield* tracker.refresh;
    state.rows = undefined;
    yield* tracker.stop;
    assert.deepEqual(state.killed, []);
  }),
);

it("parses ps rows with their start times and skips malformed lines", () => {
  assert.deepEqual(
    parseClaudeProcessTable(
      "  100     1   100 Tue Nov 17 21:00:00 2026\nnot a row\n  200   100   100 Tue Nov 17 21:00:01 2026\n",
    ),
    [row(100, 1, "Tue Nov 17 21:00:00 2026"), row(200, 100, "Tue Nov 17 21:00:01 2026", 100)],
  );
});

// regression (review P2-1): rows a whole table no longer lists are dropped, so a session's map
// holds only live jobs and a later process with the same identity is not one of its own.
it.effect("forgets a job a whole table no longer lists", () =>
  Effect.gen(function* () {
    const { state, sampler } = fakeTable([row(100, 1, "A"), row(200, 100, "B")]);
    const tracker = (yield* sampler).track(100);
    yield* tracker.refresh;
    state.rows = [row(100, 1, "A")];
    yield* tracker.refresh;
    // The same pid and start time again, now under launchd: never seen as this CLI's job.
    state.rows = [row(200, 1, "B")];
    yield* tracker.stop;
    assert.deepEqual(state.killed, []);
  }),
);

// regression (review P3-6): the poll is the owning layer's, so it stops with that layer.
it.effect("stops sampling when its layer closes", () =>
  Effect.gen(function* () {
    const { state, sampler } = fakeTable([]);
    yield* Effect.scoped(Effect.map(sampler, ({ track }) => track(100)));
    const afterClose = state.reads;
    yield* TestClock.adjust("10 seconds");
    assert.equal(state.reads, afterClose);
  }),
);

// regression (fix review P3-1): a read that fails forgets nothing, so the stop still finds the job.
it.effect("a failed read between samples keeps what the last whole table showed", () =>
  Effect.gen(function* () {
    const { state, sampler } = fakeTable([row(100, 1, "A"), row(200, 100, "B")]);
    const tracker = (yield* sampler).track(100);
    yield* tracker.refresh;
    state.rows = undefined;
    yield* tracker.refresh;
    // The CLI exited; its job was re-parented to launchd.
    state.rows = [row(200, 1, "B")];
    yield* tracker.stop;
    assert.deepEqual(state.killed, [200]);
  }),
);

it.effect("serializes process table reads for polling and explicit refresh", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    let active = 0;
    let maxActive = 0;
    let reads = 0;
    const sampler = yield* makeClaudeDescendantSampler({
      interval: "1 hour",
      readTable: Effect.gen(function* () {
        active++;
        maxActive = Math.max(maxActive, active);
        if (++reads === 1) {
          yield* Deferred.succeed(started, undefined);
          yield* Deferred.await(release);
        }
        active--;
        return Option.some([]);
      }),
      kill: () => {},
    });
    const tracker = sampler.track(100);
    yield* Deferred.await(started);
    const refresh = yield* Effect.forkChild(tracker.refresh, { startImmediately: true });
    yield* Deferred.succeed(release, undefined);
    yield* Fiber.join(refresh);
    yield* tracker.stop;
    assert.equal(maxActive, 1);
  }),
);
