import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";

import { FOLLOWER_RESTART_DELAYS_MS } from "./launchWatchFollower.ts";
import {
  advanceUntil,
  finished,
  local,
  makeWorld,
  pendingRuns,
  run1,
  run2,
  tempDir,
  watchLocal,
  withService,
} from "./LaunchWatchService.testkit.ts";

describe("LaunchWatchService a follower that hits a defect", () => {
  it.effect("is restarted after a backoff on the clock and still reports the run", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.take(world.waitStarted);
          yield* Queue.offer(world.waits, Effect.die(new Error("follower bug")));
          expect(yield* advanceUntil(Queue.take(world.waitStarted))).toBe(run1);
          yield* Queue.offer(world.waits, finished(run1));
          expect((yield* Queue.take(world.delivered)).text).toContain("completed");
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("tells the launcher it lost track after repeated defects and keeps the watch", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.take(world.waitStarted);
          const startedAt = [yield* Clock.currentTimeMillis];
          for (let restart = 0; restart < FOLLOWER_RESTART_DELAYS_MS.length; restart++) {
            yield* Queue.offer(world.waits, Effect.die(new Error("follower bug")));
            yield* advanceUntil(Queue.take(world.waitStarted));
            startedAt.push(yield* Clock.currentTimeMillis);
          }
          // Each restart waits out its own backoff on the clock, in steps of advanceUntil's 10s.
          FOLLOWER_RESTART_DELAYS_MS.forEach((delay, index) => {
            const gap = (startedAt[index + 1] ?? 0) - (startedAt[index] ?? 0);
            expect(gap).toBeGreaterThanOrEqual(delay);
            expect(gap).toBeLessThan(delay + 10_000);
          });
          yield* Queue.offer(world.waits, Effect.die(new Error("follower bug")));
          const lost = yield* Queue.take(world.delivered);
          expect(lost.text).toContain("lost track");
          expect(lost.text).toContain("may still be running");
          // Nothing reports a failure the run may not have had; its run stays pending.
          expect(yield* pendingRuns(service)).toEqual([run1]);
          // The next send to the thread follows it again.
          yield* service.rearm({ ...local, runId: run2 });
          expect(yield* Queue.take(world.waitStarted)).toBe(run1);
        }),
      );
      expect(world.waitCalls).toHaveLength(FOLLOWER_RESTART_DELAYS_MS.length + 2);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("tells the launcher again when the follower of its next send also keeps failing", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      /** Fails the running follower until it gives up, and returns the notice it sends. */
      const failUntilLost = Effect.gen(function* () {
        for (let restart = 0; restart < FOLLOWER_RESTART_DELAYS_MS.length; restart++) {
          yield* Queue.offer(world.waits, Effect.die(new Error("follower bug")));
          yield* advanceUntil(Queue.take(world.waitStarted));
        }
        yield* Queue.offer(world.waits, Effect.die(new Error("follower bug")));
        return yield* Queue.take(world.delivered);
      });
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.take(world.waitStarted);
          const first = yield* failUntilLost;
          yield* service.rearm({ ...local, runId: run2 });
          yield* Queue.take(world.waitStarted);
          const second = yield* failUntilLost;
          expect(second.text).toContain("lost track");
          expect(second.commandId).not.toBe(first.commandId);
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
