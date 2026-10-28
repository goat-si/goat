import type { HostPowerSnapshot } from "@goat/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import type * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../config.ts";
import * as NativeTelemetry from "./NativeTelemetryClient.ts";
import * as ResourceMonitorBinary from "./ResourceMonitorBinary.ts";
import {
  commitCollectionControlUpdate,
  synchronizeCollectionControlOnStart,
} from "./NativeTelemetryClient.ts";

const basePower: HostPowerSnapshot = {
  source: "electron-main",
  idle: "false",
  idleSeconds: 0,
  locked: "false",
  suspended: false,
  onBattery: "false",
  lowPowerMode: "false",
  thermalState: "nominal",
  stale: false,
  updatedAt: DateTime.makeUnsafe("2026-06-17T12:00:00.000Z"),
};

describe("commitCollectionControlUpdate", () => {
  it.effect("retains desired demand and retries unapplied sidecar state", () =>
    Effect.gen(function* () {
      const initial = {
        hostPower: basePower,
        liveSubscriberCount: 0,
        sampleIntervalMs: 5_000,
      };
      const desired = yield* Ref.make(initial);
      const applied = yield* Ref.make(initial);
      const failure = new Error("sidecar write failed");
      const receivedStates: Array<readonly [number, number]> = [];

      const received = yield* commitCollectionControlUpdate(
        desired,
        applied,
        (current) => ({
          ...current,
          liveSubscriberCount: 1,
          sampleIntervalMs: 1_000,
        }),
        (previous, next) => {
          receivedStates.push([previous.sampleIntervalMs, next.sampleIntervalMs]);
          return Effect.fail(failure);
        },
      ).pipe(Effect.flip);

      expect(received).toBe(failure);
      expect(yield* Ref.get(desired)).toEqual({
        ...initial,
        liveSubscriberCount: 1,
        sampleIntervalMs: 1_000,
      });
      expect(yield* Ref.get(applied)).toEqual(initial);

      yield* commitCollectionControlUpdate(
        desired,
        applied,
        (current) => current,
        (previous, next) => {
          receivedStates.push([previous.sampleIntervalMs, next.sampleIntervalMs]);
          return Effect.void;
        },
      );
      expect(receivedStates).toEqual([
        [5_000, 1_000],
        [5_000, 1_000],
      ]);
      expect(yield* Ref.get(applied)).toEqual(yield* Ref.get(desired));
    }),
  );

  it.effect("serializes startup synchronization with runtime control updates", () =>
    Effect.gen(function* () {
      const initial = {
        hostPower: basePower,
        liveSubscriberCount: 0,
        sampleIntervalMs: 5_000,
      };
      const desired = yield* Ref.make(initial);
      const applied = yield* Ref.make(initial);
      const ready = yield* Ref.make(false);
      const mutex = yield* Semaphore.make(1);
      const startupApplying = yield* Deferred.make<void>();
      const releaseStartup = yield* Deferred.make<void>();
      const appliedIntervals: Array<number> = [];

      const startupFiber = yield* synchronizeCollectionControlOnStart(
        mutex,
        desired,
        applied,
        (control) =>
          Effect.sync(() => {
            appliedIntervals.push(control.sampleIntervalMs);
          }).pipe(
            Effect.andThen(Deferred.succeed(startupApplying, undefined)),
            Effect.andThen(Deferred.await(releaseStartup)),
            Effect.asVoid,
          ),
        Ref.set(ready, true),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(startupApplying);

      const updateFiber = yield* mutex
        .withPermits(1)(
          commitCollectionControlUpdate(
            desired,
            applied,
            (current) => ({
              ...current,
              liveSubscriberCount: 1,
              sampleIntervalMs: 1_000,
            }),
            (_previous, next) =>
              Effect.gen(function* () {
                expect(yield* Ref.get(ready)).toBe(true);
                appliedIntervals.push(next.sampleIntervalMs);
              }),
          ),
        )
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      expect(yield* Ref.get(desired)).toEqual(initial);

      yield* Deferred.succeed(releaseStartup, undefined);
      yield* Fiber.join(startupFiber);
      yield* Fiber.join(updateFiber);

      expect(appliedIntervals).toEqual([5_000, 1_000]);
      expect(yield* Ref.get(applied)).toEqual(yield* Ref.get(desired));
    }),
  );
});

it.effect("publishes recovery after a TERM-resistant telemetry child is retired", () =>
  Effect.gen(function* () {
    const firstSpawn = yield* Deferred.make<void>();
    const killEntered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const forceMayComplete = yield* Deferred.make<void>();
    let spawns = 0;
    const spawner = ChildProcessSpawner.make(() =>
      Effect.gen(function* () {
        spawns++;
        const exit = yield* Deferred.make<ChildProcessSpawner.ExitCode>();
        const kill = (options?: ChildProcess.KillOptions) =>
          Effect.gen(function* () {
            if (yield* Deferred.isDone(exit)) return;
            yield* Deferred.succeed(killEntered, undefined);
            if (options?.forceKillAfter === undefined) yield* Deferred.await(release);
            else yield* Deferred.await(forceMayComplete);
            yield* Deferred.succeed(exit, ChildProcessSpawner.ExitCode(0));
          });
        yield* Deferred.succeed(firstSpawn, undefined);
        return ChildProcessSpawner.makeHandle({
          pid: ChildProcessSpawner.ProcessId(4242),
          exitCode: Deferred.await(exit),
          isRunning: Effect.succeed(true),
          kill,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.drain,
          stdout: Stream.never,
          stderr: Stream.empty,
          all: Stream.never,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.never,
        });
      }),
    );
    const client = yield* NativeTelemetry.make().pipe(
      Effect.provideService(ResourceMonitorBinary.ResourceMonitorBinary, {
        resolve: Effect.succeed("/fixture/monitor"),
      }),
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
      Effect.provide(ServerConfig.layerTest("/fixture", { prefix: "wp12-test-" })),
    );
    try {
      yield* Deferred.await(firstSpawn);
      yield* TestClock.adjust("5 seconds");
      yield* Deferred.await(killEntered);
      yield* TestClock.adjust("2 seconds");
      yield* Deferred.succeed(forceMayComplete, undefined);
      yield* TestClock.adjust("0 millis");
      expect((yield* client.health).restartCount).toBe(1);
      expect(spawns).toBe(1);
    } finally {
      yield* Deferred.succeed(forceMayComplete, undefined);
      yield* Deferred.succeed(release, undefined);
    }
  }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
);
