import { assert, it } from "@effect/vitest";
import { NodeId, RunId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Coordinator from "./RemoteDispatchCoordinator.ts";
import {
  answer,
  database,
  fixture,
  heldAfterDrains,
  origin,
  remote,
  report,
  runId,
} from "./RemoteDispatchCoordinator.testkit.ts";

it.effect("regression goat#3569: settled dispatches leave no drain owner or row lock behind", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      assert.deepEqual(yield* heldAfterDrains(c), { owners: 0, locks: 0 });
      for (const _ of [1, 2, 3]) {
        const launched = yield* f.launch(c, "next_turn");
        yield* Queue.take(f.calls);
        yield* f.replyLatest(Effect.succeed(answer([report(1)], "completed")));
        yield* Queue.take(f.commits);
        assert.equal((yield* c.get(launched.correlationId))?.state, "settled");
        yield* f.sql`UPDATE remote_dispatches SET remote_thread_id = ${launched.correlationId}`;
      }
      assert.deepEqual(yield* heldAfterDrains(c), { owners: 0, locks: 0 });
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);

it.effect("a drain replaced while its row runs leaves the row to the new drain", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      const task = yield* c.launch(
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
      assert.equal((yield* Queue.take(f.calls)).call.tool, "goat_origin_reports_wait");
      // A cancel restarts the drain; the replaced drain must not take the new one's owner.
      const cancel = yield* c
        .cancel(task.correlationId, Effect.succeed("approval-required"))
        .pipe(Effect.forkChild);
      const interrupt = yield* Queue.take(f.calls);
      assert.equal(interrupt.call.tool, "goat_thread_interrupt");
      yield* Queue.offer(
        interrupt.reply,
        Effect.succeed({ host: "box", threadId: remote, runId, status: "interrupt_requested" }),
      );
      assert.equal(yield* Fiber.join(cancel), "cancel_requested");
      const read = yield* Queue.take(f.calls);
      assert.equal(read.call.tool, "goat_origin_reports_wait");
      yield* Queue.offer(read.reply, Effect.succeed(answer([], "interrupted")));
      yield* Queue.take(f.commits);
      assert.notEqual((yield* c.get(task.correlationId))?.state, "running");
      assert.deepEqual(yield* heldAfterDrains(c), { owners: 0, locks: 0 });
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);

it.effect("a row still running after a pass keeps its owner, and the same drain reads on", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      const launched = yield* f.launch(c, "next_turn");
      yield* Queue.take(f.calls);
      yield* f.replyLatest(Effect.succeed(answer([report(1)], "running")));
      yield* Queue.take(f.commits);
      assert.equal((yield* c.get(launched.correlationId))?.reportCursor, 1);
      // The next read comes from the same drain: one read waits, none from a second drain.
      yield* Queue.take(f.calls);
      assert.equal(yield* Queue.size(f.calls), 0);
      yield* f.replyLatest(Effect.succeed(answer([report(1), report(2)], "completed")));
      yield* Queue.take(f.commits);
      const row = (yield* c.get(launched.correlationId))!;
      assert.equal(row.reportCursor, 2);
      assert.equal(row.state, "settled");
      assert.deepEqual(yield* heldAfterDrains(c), { owners: 0, locks: 0 });
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(database)),
);
