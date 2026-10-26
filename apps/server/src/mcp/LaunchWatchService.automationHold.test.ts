import * as AutomationHold from "../automationHold.ts";
import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import {
  launcher,
  target,
  run1,
  makeWorld,
  withService,
  tempDir,
  finished,
  watchLocal,
} from "./LaunchWatchService.testkit.ts";
import {
  remoteRead,
  watchReplica,
  replicaWatchInput,
  recoveryInput,
  recoveryGrant,
} from "./LaunchWatchService.replica.testkit.ts";

describe("LaunchWatchService", () => {
  it.effect("held: no follower dispatch or reads; release: the launcher receives the result", () =>
    Effect.gen(function* () {
      const hold = yield* AutomationHold.makeInMemory({
        reason: "channel-copy",
        heldAt: "2026-10-25T00:00:00.000Z",
      });
      const world = yield* makeWorld;
      const baseDir = yield* tempDir;
      yield* withService(world, baseDir, (service) =>
        Effect.gen(function* () {
          yield* watchLocal(service, run1);
          yield* Queue.offer(world.waits, finished(run1));
          yield* TestClock.adjust(0);
          expect(world.waitCalls).toHaveLength(0);
          expect(world.attempts).toHaveLength(0);
          expect(yield* service.list(launcher)).toHaveLength(1);
          yield* hold.release;
          expect((yield* Queue.take(world.delivered)).threadId).toBe(launcher);
        }),
      ).pipe(Effect.provideService(AutomationHold.AutomationHold, hold));
    }),
  );
});

describe("ordinary watch replicas", () => {
  it.effect("held: no retired source interruption; release: the source is interrupted", () =>
    Effect.gen(function* () {
      const world = yield* makeWorld;
      const replica = watchReplica(yield* Clock.currentTimeMillis);
      const interrupted = yield* Queue.unbounded<void>();
      world.hostCall = (call) => {
        if (call.tool === "goat_thread_checkpoint_capture")
          return Effect.succeed({ status: "captured", replica });
        if (call.tool === "goat_thread_checkpoint_restore")
          return Effect.succeed({
            operationId: call.arguments.operationId,
            status: "launched",
            threadId: "replacement",
            runId: "replacement-run",
          });
        if (call.tool === "goat_thread_interrupt")
          return Queue.offer(interrupted, undefined).pipe(
            Effect.as({ threadId: target, runId: run1, status: "interrupt_requested" }),
          );
        if (call.host === "destination") return Effect.never;
        return Effect.succeed(
          call.tool === "goat_thread_wait"
            ? { threadId: target, runId: run1, status: "completed", timedOut: false }
            : remoteRead({ itemCount: 0 }),
        );
      };
      const dir = yield* tempDir;
      yield* withService(world, dir, (service) =>
        Effect.gen(function* () {
          yield* service.register({
            ...replicaWatchInput,
            checkpointReplication: "on",
            replicaCeiling: "full-access",
          });
          yield* Queue.take(world.delivered);
          expect((yield* service.find(replicaWatchInput))?.replica).toBeDefined();
        }),
      );
      const hold = yield* AutomationHold.makeInMemory({
        reason: "channel-copy",
        heldAt: "2026-10-25T00:00:00.000Z",
      });
      yield* withService(world, dir, (service) =>
        Effect.gen(function* () {
          expect((yield* service.recover(recoveryInput, recoveryGrant)).status).toBe("launched");
          yield* TestClock.adjust(0);
          expect(yield* Queue.size(interrupted)).toBe(0);
          expect((yield* service.find(replicaWatchInput))?.recovery?.status).toBe("launched");
          yield* hold.release;
          yield* Queue.take(interrupted);
        }),
      ).pipe(Effect.provideService(AutomationHold.AutomationHold, hold));
    }),
  );
});
