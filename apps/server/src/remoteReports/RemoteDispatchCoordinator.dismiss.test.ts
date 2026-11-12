import { assert, it } from "@effect/vitest";
import { NodeId, RunId, ThreadId } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as TestClock from "effect/testing/TestClock";
import type * as LaunchWatchService from "../mcp/LaunchWatchService.ts";
import { unwatchLaunch } from "../mcp/unwatchLaunch.ts";
import * as Ssh from "../sshRemote/SshRemoteDispatch.ts";
import * as Coordinator from "./RemoteDispatchCoordinator.ts";
import {
  answer,
  database,
  fixture,
  origin,
  remote,
  report,
} from "./RemoteDispatchCoordinator.testkit.ts";

const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const offline = Effect.fail(
  new Ssh.SshRemoteDispatchError({ reason: "host_unavailable", message: "fixture" }),
);
const steadyRandom = Effect.provideService(Random.Random, {
  nextIntUnsafe: () => 0,
  nextDoubleUnsafe: () => 0.9999,
});

it.effect("dismissing a thread whose host is unreachable stops following it at once", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      const launched = yield* f.launch(c, "next_turn");
      yield* Queue.take(f.calls).pipe(Effect.flatMap((read) => Queue.offer(read.reply, offline)));
      yield* TestClock.adjust("300 seconds");
      // The drain's next long-poll is in flight when the person dismisses the launch.
      const pending = yield* Queue.take(f.calls);
      const since = (yield* c.get(launched.correlationId))!.hostUnavailableSince;
      const dismissed = yield* c.dismiss({ host: "box", remoteThreadId: remote });
      assert.deepEqual(
        dismissed.map((record) => record.correlationId),
        [launched.correlationId],
      );
      yield* Queue.offer(pending.reply, Effect.succeed(answer([report(1)])));
      yield* TestClock.adjust("1 hour");
      const row = (yield* c.get(launched.correlationId))!;
      assert.equal(row.state, "cancelled");
      assert.equal(row.endReason, "dismissed");
      assert.equal(row.endedAt, iso((yield* Clock.currentTimeMillis) - 3_600_000));
      assert.equal(
        row.lastError,
        `Dismissed without contacting box. It had not answered since ${since}.`,
      );
      assert.equal(row.reportCursor, 0);
      assert.equal(yield* Queue.size(f.calls), 0);
      assert.deepEqual(yield* c.dismiss({ host: "box", remoteThreadId: remote }), []);
    }).pipe(Effect.provide(f.layer), steadyRandom);
  }).pipe(Effect.provide(database)),
);

it.effect(
  "a thread whose host still answers, another thread's launch and a task are not dismissed",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const c = yield* Coordinator.RemoteDispatchCoordinator;
        const launched = yield* f.launch(c, "next_turn");
        yield* Queue.take(f.calls);
        assert.deepEqual(yield* c.dismiss({ host: "box", remoteThreadId: remote }), []);
        yield* f.sql`UPDATE remote_dispatches SET host_unavailable_since = ${iso(0)}`;
        assert.deepEqual(
          yield* c.dismiss({
            host: "box",
            remoteThreadId: remote,
            originThreadId: ThreadId.make("someone-else"),
          }),
          [],
        );
        yield* f.sql`UPDATE remote_dispatches SET kind = 'task', task_id = ${NodeId.make("task")},
        parent_run_id = ${RunId.make("parent")}`;
        assert.deepEqual(yield* c.dismiss({ host: "box", remoteThreadId: remote }), []);
        assert.equal((yield* c.get(launched.correlationId))!.state, "running");
        yield* f.sql`UPDATE remote_dispatches SET kind = 'thread', task_id = NULL, parent_run_id = NULL`;
        assert.lengthOf(
          yield* c.dismiss({ host: "box", remoteThreadId: remote, originThreadId: origin }),
          1,
        );
      }).pipe(Effect.provide(f.layer), steadyRandom);
    }).pipe(Effect.provide(database)),
);

it.effect("a send after a dismissal follows the thread again with a fresh drain", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      const launched = yield* f.launch(c, "next_turn");
      yield* Queue.take(f.calls).pipe(Effect.flatMap((read) => Queue.offer(read.reply, offline)));
      yield* TestClock.adjust("300 seconds");
      const stale = yield* Queue.take(f.calls);
      yield* c.dismiss({ host: "box", remoteThreadId: remote });
      yield* c.resume("box", remote);
      const fresh = yield* Queue.take(f.calls);
      const resumed = (yield* c.get(launched.correlationId))!;
      assert.equal(resumed.state, "running");
      assert.isNull(resumed.endReason);
      assert.isNull(resumed.hostUnavailableSince);
      // The dismissed drain's answer arrives late; only the resumed drain imports.
      yield* Queue.offer(stale.reply, Effect.succeed(answer([report(1), report(2)])));
      yield* Queue.offer(fresh.reply, Effect.succeed(answer([report(1)])));
      yield* Queue.take(f.commits);
      yield* TestClock.adjust("1 second");
      assert.equal((yield* c.get(launched.correlationId))!.reportCursor, 1);
    }).pipe(Effect.provide(f.layer), steadyRandom);
  }).pipe(Effect.provide(database)),
);

it.effect(
  "goat_thread_unwatch stops only the calling thread's own reports from an unreachable host",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const coordinator = yield* Coordinator.RemoteDispatchCoordinator;
        const launched = yield* f.launch(coordinator, "next_turn");
        yield* Queue.take(f.calls);
        const launchWatches = {
          unwatch: () => Effect.succeed(true),
        } as unknown as LaunchWatchService.LaunchWatchServiceShape;
        const unwatch = (launcherThreadId: ThreadId) =>
          unwatchLaunch({
            launchWatches,
            coordinator,
            launcherThreadId,
            target: { host: "box", threadId: remote },
          });
        // Its host still answers: reports keep arriving.
        assert.equal((yield* unwatch(origin)).reportsStopped, false);
        const nowMs = yield* Clock.currentTimeMillis;
        // A minute-long blip: an agent that unwatches then only meant to drop its wakes.
        yield* f.sql`UPDATE remote_dispatches SET host_unavailable_since = ${iso(nowMs - 60_000)},
          host_last_failed_at = ${iso(nowMs)}`;
        assert.equal((yield* unwatch(origin)).reportsStopped, false);
        assert.equal((yield* coordinator.get(launched.correlationId))!.state, "running");
        // An old outage start whose last failed contact is an hour old: this machine was away
        // since, so nothing shows the host is still silent.
        yield* f.sql`UPDATE remote_dispatches SET host_unavailable_since = ${iso(nowMs - 2 * 60 * 60_000)},
          host_last_failed_at = ${iso(nowMs - 60 * 60_000)}`;
        assert.equal((yield* unwatch(origin)).reportsStopped, false);
        yield* f.sql`UPDATE remote_dispatches SET host_unavailable_since = ${iso(nowMs - 15 * 60_000)},
          host_last_failed_at = ${iso(nowMs)}`;
        assert.equal((yield* unwatch(ThreadId.make("another-thread"))).reportsStopped, false);
        assert.equal((yield* coordinator.get(launched.correlationId))!.state, "running");
        assert.deepEqual(yield* unwatch(origin), {
          host: "box",
          threadId: remote,
          removed: true,
          reportsStopped: true,
        });
        assert.equal((yield* coordinator.get(launched.correlationId))!.endReason, "dismissed");
      }).pipe(Effect.provide(f.layer), steadyRandom);
    }).pipe(Effect.provide(database)),
);
