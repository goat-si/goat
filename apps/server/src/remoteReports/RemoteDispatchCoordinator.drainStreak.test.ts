import { assert, it } from "@effect/vitest";
import { NodeId, RunId } from "@goat/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";
import * as Coordinator from "./RemoteDispatchCoordinator.ts";
import { answer, database, fixture, origin } from "./RemoteDispatchCoordinator.testkit.ts";

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

it.effect(
  "regression goat#3568: a drain failing three times in a row tells the origin once that it lost track, and keeps trying",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const c = yield* Coordinator.RemoteDispatchCoordinator;
        const launched = yield* launchTask(c);
        yield* Queue.take(f.notifications);
        const notices: Array<string> = [];
        // Each pass fails on a reply the drain cannot decode; one good pass ends the streak.
        const passes = ["bad", "bad", "bad", "bad", "good", "bad", "bad", "bad"] as const;
        let backoff = 5_000;
        for (const pass of passes) {
          const read = yield* Queue.take(f.calls);
          while ((yield* Queue.size(f.notifications)) > 0) {
            const notice = yield* Queue.take(f.notifications);
            if (notice.type === "message.dispatch") notices.push(String(notice.commandId));
          }
          if (pass === "good") {
            yield* Queue.offer(read.reply, Effect.succeed(answer([], "running")));
            backoff = 5_000;
            continue;
          }
          yield* Queue.offer(read.reply, Effect.succeed({ unreadable: true }));
          yield* TestClock.adjust(backoff);
          backoff *= 2;
        }
        yield* Queue.take(f.calls);
        while ((yield* Queue.size(f.notifications)) > 0) {
          const notice = yield* Queue.take(f.notifications);
          if (notice.type === "message.dispatch") notices.push(String(notice.commandId));
        }
        assert.lengthOf(notices, 2);
        for (const notice of notices)
          assert.include(notice, `remote-drain-lost:${launched.correlationId}:`);
        assert.notEqual(notices[0], notices[1]);
        assert.equal((yield* c.get(launched.correlationId))?.state, "running");
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(database)),
);
