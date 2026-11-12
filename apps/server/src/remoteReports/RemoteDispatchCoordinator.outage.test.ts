import { assert, it } from "@effect/vitest";
import {
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  type OrchestrationV2Subagent,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Random from "effect/Random";
import * as TestClock from "effect/testing/TestClock";
import * as Ssh from "../sshRemote/SshRemoteDispatch.ts";
import * as Coordinator from "./RemoteDispatchCoordinator.ts";
import { answer, database, fixture, origin, remote } from "./RemoteDispatchCoordinator.testkit.ts";

const DAY = 24 * 60 * 60_000;
const iso = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const unreachable = (
  reason: "host_unavailable" | "ssh_failed" | "host_unknown" = "host_unavailable",
) => Effect.fail(new Ssh.SshRemoteDispatchError({ reason, message: "fixture" }));
// Full-length retries, so one 300 s step always reaches the next call.
const steadyRandom = Effect.provideService(Random.Random, {
  nextIntUnsafe: () => 0,
  nextDoubleUnsafe: () => 0.9999,
});

type Fixture = Effect.Success<typeof fixture>;
const failNext = (f: Fixture, reason?: "host_unavailable" | "ssh_failed" | "host_unknown") =>
  Effect.gen(function* () {
    const read = yield* Queue.take(f.calls);
    yield* Queue.offer(read.reply, unreachable(reason));
  });
/** Waits for the drain's next call, which it makes only after committing the previous outcome. */
const nextCall = (f: Fixture) =>
  Effect.gen(function* () {
    yield* TestClock.adjust("300 seconds");
    return yield* Queue.take(f.calls);
  });
/** An outage that began at sinceMs and whose latest failed contact was just now. */
const setSince = (f: Fixture, id: string, sinceMs: number) =>
  Effect.gen(function* () {
    const lastMs = yield* Clock.currentTimeMillis;
    yield* f.sql`UPDATE remote_dispatches SET host_unavailable_since = ${iso(sinceMs)},
      host_last_failed_at = ${iso(lastMs)} WHERE correlation_id = ${id}`;
  });

it.effect(
  "an unreachable host records when the outage began and never bumps the ordering time",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const c = yield* Coordinator.RemoteDispatchCoordinator;
        const launched = yield* f.launch(c, "notify_only");
        const before = (yield* c.get(launched.correlationId))!;
        const startedAt = yield* Clock.currentTimeMillis;
        yield* failNext(f);
        const second = yield* nextCall(f);
        const first = (yield* c.get(launched.correlationId))!;
        assert.equal(first.hostUnavailableSince, iso(startedAt));
        assert.equal(first.state, "running");
        assert.equal(first.updatedAt, before.updatedAt);
        yield* Queue.offer(second.reply, unreachable("ssh_failed"));
        yield* nextCall(f);
        const later = (yield* c.get(launched.correlationId))!;
        assert.equal(later.hostUnavailableSince, iso(startedAt));
        assert.equal(later.updatedAt, before.updatedAt);
        assert.equal(later.lastError, `Host unavailable since ${iso(startedAt)}.`);
      }).pipe(Effect.provide(f.layer), steadyRandom);
    }).pipe(Effect.provide(database)),
);

it.effect("a host missing from the SSH config is an outage, not a lost binding", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      const launched = yield* f.launch(c, "notify_only");
      yield* failNext(f, "host_unknown");
      yield* TestClock.adjust("300 seconds");
      const row = (yield* c.get(launched.correlationId))!;
      assert.equal(row.state, "running");
      assert.isNotNull(row.hostUnavailableSince);
    }).pipe(Effect.provide(f.layer), steadyRandom);
  }).pipe(Effect.provide(database)),
);

it.effect("an answer from the host ends the outage", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      const launched = yield* f.launch(c, "notify_only");
      yield* failNext(f);
      const read = yield* nextCall(f);
      yield* Queue.offer(read.reply, Effect.succeed(answer([])));
      yield* Queue.take(f.calls);
      assert.isNull((yield* c.get(launched.correlationId))!.hostUnavailableSince);
    }).pipe(Effect.provide(f.layer), steadyRandom);
  }).pipe(Effect.provide(database)),
);

it.effect(
  "a thread unreachable for 24 hours is lost once, its origin told once, and only probed afterwards",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const c = yield* Coordinator.RemoteDispatchCoordinator;
        const launched = yield* f.launch(c, "notify_only");
        const id = launched.correlationId;
        yield* Queue.take(f.calls).pipe(
          Effect.flatMap((read) => Queue.offer(read.reply, unreachable())),
        );
        let read = yield* nextCall(f);
        // One millisecond short of a day: still followed.
        yield* setSince(f, id, (yield* Clock.currentTimeMillis) - DAY + 1);
        yield* Queue.offer(read.reply, unreachable());
        read = yield* nextCall(f);
        assert.equal((yield* c.get(id))!.state, "running");
        assert.equal(yield* Queue.size(f.notifications), 0);
        const sinceMs = (yield* Clock.currentTimeMillis) - DAY;
        yield* setSince(f, id, sinceMs);
        yield* Queue.offer(read.reply, unreachable());
        yield* TestClock.adjust("1 hour");
        assert.deepEqual(
          (yield* Queue.clear(f.notifications)).map((command) => command.commandId),
          [`server:remote-host-lost:${id}:${iso(sinceMs)}`],
        );
        const row = (yield* c.get(id))!;
        assert.equal(row.state, "lost");
        assert.equal(row.endReason, "host_unreachable");
        assert.equal(row.lastError, `box has not answered since ${iso(sinceMs)}.`);
        assert.equal(row.hostUnavailableSince, iso(sinceMs));
        // The drain stopped; what still reaches the host is the read-only probe that returns at once.
        for (const later of yield* Queue.clear(f.calls)) {
          assert.equal(later.call.arguments.timeoutMs, 0);
          assert.equal(later.call.writes, false);
        }
        assert.equal(yield* Queue.size(f.notifications), 0);
      }).pipe(Effect.provide(f.layer), steadyRandom);
    }).pipe(Effect.provide(database)),
);

it.effect(
  "a day this machine was away does not count as the host's silence: the outage clock restarts",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const c = yield* Coordinator.RemoteDispatchCoordinator;
        const launched = yield* f.launch(c, "notify_only");
        const read = yield* Queue.take(f.calls);
        // The host stopped answering, then this machine slept for two days without asking.
        const nowMs = yield* Clock.currentTimeMillis;
        yield* f.sql`UPDATE remote_dispatches SET host_unavailable_since = ${iso(nowMs - 2 * DAY)},
          host_last_failed_at = ${iso(nowMs - 2 * DAY)} WHERE correlation_id = ${launched.correlationId}`;
        yield* Queue.offer(read.reply, unreachable());
        yield* TestClock.adjust("1 second");
        assert.equal((yield* Queue.clear(f.notifications)).length, 0);
        const row = (yield* c.get(launched.correlationId))!;
        assert.equal(row.state, "running");
        assert.equal(row.hostUnavailableSince, iso(nowMs));
      }).pipe(Effect.provide(f.layer), steadyRandom);
    }).pipe(Effect.provide(database)),
);

it.effect("a lost notice that fails to deliver keeps the row running until it is delivered", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      const launched = yield* f.launch(c, "notify_only");
      const id = launched.correlationId;
      let read = yield* Queue.take(f.calls);
      yield* setSince(f, id, (yield* Clock.currentTimeMillis) - DAY);
      f.failDelivery(true);
      yield* Queue.offer(read.reply, unreachable());
      read = yield* nextCall(f);
      assert.equal((yield* Queue.clear(f.failedDeliveries)).length, 1);
      assert.equal((yield* c.get(id))!.state, "running");
      f.failDelivery(false);
      yield* Queue.offer(read.reply, unreachable());
      yield* TestClock.adjust("1 hour");
      assert.equal((yield* Queue.clear(f.notifications)).length, 1);
      assert.equal((yield* c.get(id))!.state, "lost");
      assert.equal(yield* Queue.size(f.notifications), 0);
    }).pipe(Effect.provide(f.layer), steadyRandom);
  }).pipe(Effect.provide(database)),
);

it.effect("a notice accepted before a crash is not sent again when tracking ends", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      const launched = yield* f.launch(c, "notify_only");
      const read = yield* Queue.take(f.calls);
      const sinceMs = (yield* Clock.currentTimeMillis) - DAY;
      yield* setSince(f, launched.correlationId, sinceMs);
      f.receipts.add(`server:remote-host-lost:${launched.correlationId}:${iso(sinceMs)}`);
      yield* Queue.offer(read.reply, unreachable());
      yield* TestClock.adjust("1 hour");
      assert.equal((yield* c.get(launched.correlationId))!.state, "lost");
      assert.equal(yield* Queue.size(f.notifications), 0);
    }).pipe(Effect.provide(f.layer), steadyRandom);
  }).pipe(Effect.provide(database)),
);

const subagent = (
  taskId: string,
  status: OrchestrationV2Subagent["status"],
  result: string,
): OrchestrationV2Subagent => {
  const now = DateTime.makeUnsafe(0);
  return {
    id: NodeId.make(taskId),
    threadId: origin,
    runId: RunId.make("parent"),
    parentNodeId: NodeId.make("root"),
    origin: "app_owned",
    createdBy: "agent",
    driver: ProviderDriverKind.make("claude"),
    providerInstanceId: ProviderInstanceId.make("claude"),
    providerThreadId: null,
    childThreadId: null,
    nativeTaskRef: null,
    prompt: "work",
    title: null,
    model: null,
    status,
    result,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    remote: { host: "box", threadId: remote, correlationId: "task" },
  };
};
const launchTask = (c: Coordinator.RemoteDispatchCoordinator["Service"]) =>
  c.launch(
    {
      kind: "task",
      originThreadId: origin,
      delivery: "wake",
      task: { taskId: NodeId.make("task-A"), parentRunId: RunId.make("parent") },
      launch: {
        host: "box",
        cwd: "/fixture",
        workspace: { type: "cwd" },
        title: "task",
        message: "work",
        runtimeMode: "full-access",
        callerRuntimeMode: "full-access",
      },
    },
    Effect.void,
  );

it.effect.each([
  ["its own outage result", "failed", "own", "lost", "host_unreachable", "failed"],
  ["a completion that committed first", "completed", "done", "settled", null, "completed"],
  ["a failure that committed first", "failed", "remote failure", "settled", null, "failed"],
  ["a cancellation that committed first", "cancelled", "stopped", "cancelled", null, "cancelled"],
] as const)(
  "a task unreachable for 24 hours records one result and follows %s",
  ([, status, result, state, endReason, knownRunStatus]) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const c = yield* Coordinator.RemoteDispatchCoordinator;
        const launched = yield* launchTask(c);
        yield* Queue.take(f.notifications);
        const read = yield* Queue.take(f.calls);
        const sinceMs = (yield* Clock.currentTimeMillis) - DAY;
        yield* setSince(f, launched.correlationId, sinceMs);
        // The parent keeps the first terminal result; this is the one it committed.
        f.recordedTasks.push(
          subagent(
            "task-A",
            status,
            result === "own" ? `box has not answered since ${iso(sinceMs)}.` : result,
          ),
        );
        yield* Queue.offer(read.reply, unreachable());
        yield* TestClock.adjust("1 hour");
        assert.deepEqual(
          (yield* Queue.clear(f.notifications)).map((command) => command.type),
          ["delegated_task.remote.result"],
        );
        const row = (yield* c.get(launched.correlationId))!;
        assert.equal(row.state, state);
        assert.equal(row.endReason, endReason);
        assert.equal(row.knownRunStatus, knownRunStatus);
        assert.equal(yield* Queue.size(f.notifications), 0);
      }).pipe(Effect.provide(f.layer), steadyRandom);
    }).pipe(Effect.provide(database)),
);

it.effect.each(["running", "completed"] as const)(
  "a host that answers %s after a crash still ends the task by the outage failure the parent committed",
  (status) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const c = yield* Coordinator.RemoteDispatchCoordinator;
        const launched = yield* launchTask(c);
        yield* Queue.take(f.notifications);
        const sinceMs = yield* Clock.currentTimeMillis;
        yield* failNext(f);
        const read = yield* nextCall(f);
        // The outage result committed, then the server stopped before the row turned lost.
        f.recordedTasks.push(
          subagent("task-A", "failed", `box has not answered since ${iso(sinceMs)}.`),
        );
        yield* Queue.offer(read.reply, Effect.succeed(answer([], status)));
        yield* TestClock.adjust("1 hour");
        const row = (yield* c.get(launched.correlationId))!;
        assert.equal(row.state, "lost");
        assert.equal(row.endReason, "host_unreachable");
        assert.equal(row.knownRunStatus, "failed");
        assert.equal(row.lastError, `box has not answered since ${iso(sinceMs)}.`);
        assert.equal(yield* Queue.size(f.calls), 0);
      }).pipe(Effect.provide(f.layer), steadyRandom);
    }).pipe(Effect.provide(database)),
);

it.effect("a task whose early outage notice keeps failing still ends after 24 hours", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      const launched = yield* launchTask(c);
      yield* Queue.take(f.notifications);
      f.refusedCommandTypes.add("message.dispatch");
      yield* failNext(f);
      yield* TestClock.adjust("300 seconds");
      yield* failNext(f);
      const sinceMs = (yield* Clock.currentTimeMillis) - DAY;
      yield* setSince(f, launched.correlationId, sinceMs);
      // The third unreachable outcome tries the early notice, which the origin refuses.
      const third = yield* nextCall(f);
      f.recordedTasks.push(
        subagent("task-A", "failed", `box has not answered since ${iso(sinceMs)}.`),
      );
      yield* Queue.offer(third.reply, unreachable());
      yield* TestClock.adjust("1 hour");
      assert.isTrue(f.attemptedCommands.some((command) => command.type === "message.dispatch"));
      const row = (yield* c.get(launched.correlationId))!;
      assert.equal(row.state, "lost");
      assert.equal(row.endReason, "host_unreachable");
      assert.deepEqual(
        (yield* Queue.clear(f.notifications)).map((command) => command.type),
        ["delegated_task.remote.result"],
      );
    }).pipe(Effect.provide(f.layer), steadyRandom);
  }).pipe(Effect.provide(database)),
);

it.effect(
  "an outage that had already run a day before this machine went away ends at the next failure",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const c = yield* Coordinator.RemoteDispatchCoordinator;
        const launched = yield* launchTask(c);
        yield* Queue.take(f.notifications);
        const read = yield* Queue.take(f.calls);
        // A day of failures, the outage result committed, then a crash and a day away.
        const nowMs = yield* Clock.currentTimeMillis;
        const sinceMs = nowMs - 2 * DAY;
        yield* f.sql`UPDATE remote_dispatches SET host_unavailable_since = ${iso(sinceMs)},
          host_last_failed_at = ${iso(nowMs - DAY)} WHERE correlation_id = ${launched.correlationId}`;
        f.recordedTasks.push(
          subagent("task-A", "failed", `box has not answered since ${iso(sinceMs)}.`),
        );
        yield* Queue.offer(read.reply, unreachable());
        yield* TestClock.adjust("1 second");
        const row = (yield* c.get(launched.correlationId))!;
        assert.equal(row.state, "lost");
        assert.equal(row.endReason, "host_unreachable");
        assert.equal(row.hostUnavailableSince, iso(sinceMs));
      }).pipe(Effect.provide(f.layer), steadyRandom);
    }).pipe(Effect.provide(database)),
);
