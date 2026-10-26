import * as AutomationHold from "../automationHold.ts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as Coordinator from "./RemoteDispatchCoordinator.ts";
import {
  origin,
  at,
  report,
  answer,
  fixture,
  database,
} from "./RemoteDispatchCoordinator.testkit.ts";

it.effect(
  "held: a copied running dispatch waits for release; release: it reads and dispatches the report",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const hold = yield* AutomationHold.makeInMemory({
        reason: "channel-copy",
        heldAt: "2026-10-25T00:00:00.000Z",
      });
      // The stable app launched it and was reading reports when its state was copied.
      yield* Effect.gen(function* () {
        const c = yield* Coordinator.RemoteDispatchCoordinator;
        yield* f.launch(c);
        yield* Queue.take(f.calls);
      }).pipe(Effect.provide(f.layer));

      yield* Effect.gen(function* () {
        yield* Coordinator.RemoteDispatchCoordinator;
        yield* TestClock.adjust(0);
        assert.equal(yield* Queue.size(f.calls), 0);
        assert.equal(yield* Queue.size(f.notifications), 0);
        yield* hold.release;
        const read = yield* Queue.take(f.calls);
        yield* Queue.offer(
          read.reply,
          Effect.succeed(answer([report(1, "needs_input")], "completed")),
        );
        assert.equal((yield* Queue.take(f.notifications)).type, "message.dispatch");
      }).pipe(Effect.provide(f.layer), Effect.provideService(AutomationHold.AutomationHold, hold));
    }).pipe(Effect.provide(database)),
);

it.effect("held: a dispatch a person starts on the copy reads its reports at once", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const hold = yield* AutomationHold.makeInMemory({
      reason: "channel-copy",
      heldAt: "2026-10-25T00:00:00.000Z",
    });
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      yield* f.launch(c);
      const read = yield* Queue.take(f.calls);
      yield* Queue.offer(
        read.reply,
        Effect.succeed(answer([report(1, "needs_input")], "completed")),
      );
      assert.equal((yield* Queue.take(f.notifications)).type, "message.dispatch");
    }).pipe(Effect.provide(f.layer), Effect.provideService(AutomationHold.AutomationHold, hold));
  }).pipe(Effect.provide(database)),
);

it.effect("held: no uncertain task recovery dispatch; release: the result is recovered", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    const hold = yield* AutomationHold.makeInMemory({
      reason: "channel-copy",
      heldAt: "2026-10-25T00:00:00.000Z",
    });
    yield* f.sql`INSERT INTO remote_dispatches
      (correlation_id,kind,origin_thread_id,host,read_key,delivery,state,task_id,parent_run_id,created_at,updated_at)
      VALUES ('held-task','task',${origin},'box','key','wake','launching','held-node','parent',${at},${at})`;
    yield* Effect.gen(function* () {
      const c = yield* Coordinator.RemoteDispatchCoordinator;
      assert.equal((yield* c.get("held-task"))?.state, "launching");
      assert.equal(f.attemptedCommands.length, 0);
      yield* hold.release;
      assert.equal((yield* Queue.take(f.notifications)).type, "delegated_task.remote.result");
      assert.equal(f.launches.length, 0);
    }).pipe(Effect.provide(f.layer), Effect.provideService(AutomationHold.AutomationHold, hold));
  }).pipe(Effect.provide(database)),
);
