import { assert, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as TestClock from "effect/testing/TestClock";
import * as Ssh from "../sshRemote/SshRemoteDispatch.ts";
import * as Coordinator from "./RemoteDispatchCoordinator.ts";
import { answer, database, fixture, remote, report } from "./RemoteDispatchCoordinator.testkit.ts";

const DAY = 24 * 60 * 60_000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const offline = Effect.fail(
  new Ssh.SshRemoteDispatchError({ reason: "host_unavailable", message: "fixture" }),
);
const steadyRandom = Effect.provideService(Random.Random, {
  nextIntUnsafe: () => 0,
  nextDoubleUnsafe: () => 0.9999,
});
type Fixture = Effect.Success<typeof fixture>;

/** A launched thread whose host has not answered for a day, so GOAT stopped following it. */
const lostToOutage = (f: Fixture, c: Coordinator.RemoteDispatchCoordinator["Service"]) =>
  Effect.gen(function* () {
    const launched = yield* f.launch(c, "next_turn");
    const read = yield* Queue.take(f.calls);
    yield* f.sql`UPDATE remote_dispatches SET host_unavailable_since = ${iso((yield* Clock.currentTimeMillis) - DAY)}
      WHERE correlation_id = ${launched.correlationId}`;
    yield* Queue.offer(read.reply, offline);
    yield* TestClock.adjust("1 second");
    assert.equal((yield* c.get(launched.correlationId))!.endReason, "host_unreachable");
    yield* Queue.clear(f.notifications);
    return launched.correlationId;
  });

it.effect("a host that answers again is followed again and its outage reports are imported", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      const id = yield* lostToOutage(f, c);
      const pass = yield* c.resolveLostLaunches.pipe(Effect.forkChild);
      const probe = yield* Queue.take(f.calls);
      assert.equal(probe.call.tool, "goat_origin_reports_wait");
      assert.equal(probe.call.writes, false);
      assert.equal(probe.call.arguments.timeoutMs, 0);
      yield* Queue.offer(probe.reply, Effect.succeed({ ...answer([]), timedOut: true }));
      const drain = yield* Queue.take(f.calls);
      const reopened = (yield* c.get(id))!;
      assert.equal(reopened.state, "running");
      assert.isNull(reopened.endReason);
      assert.isNull(reopened.hostUnavailableSince);
      yield* Queue.offer(drain.reply, Effect.succeed(answer([report(1)])));
      yield* Queue.take(f.commits);
      assert.equal((yield* c.get(id))!.reportCursor, 1);
      yield* Fiber.join(pass);
    }).pipe(Effect.provide(f.layer), steadyRandom);
  }).pipe(Effect.provide(database)),
);

it.effect("a host that still does not answer leaves the thread lost and is asked again later", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      const id = yield* lostToOutage(f, c);
      const pass = yield* c.resolveLostLaunches.pipe(Effect.forkChild);
      const probe = yield* Queue.take(f.calls);
      yield* Queue.offer(probe.reply, offline);
      yield* Fiber.join(pass);
      assert.equal((yield* c.get(id))!.state, "lost");
      // Asked at most every 30 minutes: an immediate second pass makes no call.
      yield* c.resolveLostLaunches;
      assert.equal(yield* Queue.size(f.calls), 0);
    }).pipe(Effect.provide(f.layer), steadyRandom);
  }).pipe(Effect.provide(database)),
);

it.effect("a send that reaches a thread lost to an outage follows it again", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      const id = yield* lostToOutage(f, c);
      yield* c.resume("box", remote);
      yield* Queue.take(f.calls);
      const row = (yield* c.get(id))!;
      assert.equal(row.state, "running");
      assert.isNull(row.endReason);
      assert.isNull(row.endedAt);
    }).pipe(Effect.provide(f.layer), steadyRandom);
  }).pipe(Effect.provide(database)),
);

/** A second thread on the same host, lost to the same outage. */
const secondLost = (f: Fixture, id: string) =>
  Effect.gen(function* () {
    yield* f.sql`CREATE TEMP TABLE copied AS SELECT * FROM remote_dispatches WHERE correlation_id = ${id}`;
    yield* f.sql`UPDATE copied SET correlation_id = 'second', read_key = 'second-key', remote_thread_id = 'remote-2'`;
    yield* f.sql`INSERT INTO remote_dispatches SELECT * FROM copied`;
    yield* f.sql`DROP TABLE copied`;
    return "second";
  });

it.effect(
  "one probe per host: a host that still does not answer costs one call for all its threads",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const c = yield* Coordinator.RemoteDispatchCoordinator;
        const id = yield* lostToOutage(f, c);
        const second = yield* secondLost(f, id);
        const pass = yield* c.resolveLostLaunches.pipe(Effect.forkChild);
        const probe = yield* Queue.take(f.calls);
        yield* Queue.offer(probe.reply, offline);
        yield* TestClock.adjust("1 second");
        assert.equal(yield* Queue.size(f.calls), 0);
        yield* Fiber.join(pass);
        assert.equal((yield* c.get(id))!.state, "lost");
        assert.equal((yield* c.get(second))!.state, "lost");
      }).pipe(Effect.provide(f.layer), steadyRandom);
    }).pipe(Effect.provide(database)),
);

it.effect(
  "one probe per host: a host that answers again is followed again for all its threads",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const c = yield* Coordinator.RemoteDispatchCoordinator;
        const id = yield* lostToOutage(f, c);
        const second = yield* secondLost(f, id);
        const pass = yield* c.resolveLostLaunches.pipe(Effect.forkChild);
        const probe = yield* Queue.take(f.calls);
        assert.equal(probe.call.tool, "goat_origin_reports_wait");
        yield* Queue.offer(probe.reply, Effect.succeed({ ...answer([]), timedOut: true }));
        yield* Fiber.join(pass);
        assert.equal((yield* c.get(id))!.state, "running");
        assert.equal((yield* c.get(second))!.state, "running");
        // Each followed thread's drain asks for its own reports; the probe asked once.
        const drains = [yield* Queue.take(f.calls), yield* Queue.take(f.calls)];
        assert.sameMembers(
          drains.map((call) => call.call.arguments.correlationId),
          [id, second],
        );
      }).pipe(Effect.provide(f.layer), steadyRandom);
    }).pipe(Effect.provide(database)),
);
