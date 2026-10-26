import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import type { HostCapacitySnapshot, HostDiskUsage } from "@goat/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ServerConfig from "../../config.ts";
import * as HostResources from "../../resourceTelemetry/HostResources.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as HostPressureMonitor from "./HostPressureMonitor.ts";
import type { PressureSample } from "./pressureModel.ts";

const reading = (loadPerCore: number): PressureSample => ({
  loadPerCore,
  cpuUtilization: 0.5,
  memoryFreeRatio: 0.5,
  diskAvailableBytes: 100 * 1024 ** 3,
  diskTotalBytes: null,
  eventLoopDelayMs: null,
});

const layer = (samples: Array<PressureSample>, enabled = true) =>
  Layer.effect(
    HostPressureMonitor.HostPressureMonitor,
    HostPressureMonitor.make(Effect.sync(() => samples.shift() ?? reading(0.1))),
  ).pipe(
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({ fleet: { pressure: { enabled } } }),
    ),
  );

const every30s = (count: number) =>
  Effect.gen(function* () {
    const monitor = yield* HostPressureMonitor.HostPressureMonitor;
    const levels = [];
    for (let index = 0; index < count; index += 1) {
      levels.push((yield* monitor.sample)?.level);
      yield* TestClock.adjust(HostPressureMonitor.PRESSURE_SAMPLE_INTERVAL_MS);
    }
    return levels;
  });

describe("HostPressureMonitor", () => {
  it.effect("raises the level after three minutes of load on the clock", () =>
    Effect.gen(function* () {
      expect(yield* every30s(7)).toEqual(["ok", "ok", "ok", "ok", "ok", "ok", "elevated"]);
      const current = yield* Effect.flatMap(
        HostPressureMonitor.HostPressureMonitor,
        (monitor) => monitor.current,
      );
      expect(current).toEqual({
        level: "elevated",
        since: "1970-01-01T00:03:00.000Z",
        reasons: [
          { signal: "load", level: "elevated", message: "load 2 per core (threshold 1.5)" },
        ],
        loadPerCore: 2,
        eventLoopDelayMs: null,
      });
    }).pipe(Effect.provide(layer(Array.from({ length: 7 }, () => reading(2))))),
  );

  it.effect("reports nothing when fleet.pressure.enabled is false", () =>
    Effect.gen(function* () {
      expect(yield* every30s(2)).toEqual([undefined, undefined]);
    }).pipe(Effect.provide(layer([reading(9), reading(9)], false))),
  );

  it.effect("streams the disk's own level once per change, not once per sample", () => {
    const GIB = 1024 ** 3;
    // 40 GiB free of 2 TiB stays elevated however calm the CPU is; a 0.3 GiB dip is not news.
    const low = (freeGiB: number): PressureSample => ({
      ...reading(0.1),
      diskAvailableBytes: Math.round(freeGiB * GIB),
      diskTotalBytes: 2048 * GIB,
      diskPath: "/",
    });
    const samples = [...Array.from({ length: 6 }, () => low(40)), low(39.7), low(39.7)];
    return Effect.gen(function* () {
      const monitor = yield* HostPressureMonitor.HostPressureMonitor;
      const subscribed = yield* Deferred.make<void>();
      const seen = yield* monitor.disk.pipe(
        Stream.tap(() => Deferred.succeed(subscribed, undefined)),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      yield* every30s(8);
      const values = Array.from(yield* Fiber.join(seen));
      expect(values.map((value) => value?.level ?? null)).toEqual([null, "ok", "elevated"]);
      expect(values[2]).toEqual({
        level: "elevated",
        since: "1970-01-01T00:03:00.000Z",
        path: "/",
        availableBytes: Math.round(39.7 * GIB),
        totalBytes: 2048 * GIB,
      });
    }).pipe(Effect.provide(layer(samples)));
  });

  it.effect(
    "takes the disk level from a worktrees folder on a fuller volume than the GOAT home",
    () =>
      Effect.gen(function* () {
        const GIB = 1024 ** 3;
        const fs = yield* FileSystem.FileSystem;
        // Settings > Storage > Worktree location on another drive, such as a Dev Drive.
        const worktrees = yield* fs.realPath(
          yield* fs.makeTempDirectoryScoped({ prefix: "pressure-worktrees-" }),
        );
        const home: HostDiskUsage = {
          path: "/goat-home",
          availableBytes: 900 * GIB,
          totalBytes: 1000 * GIB,
        };
        const fuller: HostDiskUsage = {
          path: worktrees,
          availableBytes: 20 * GIB,
          totalBytes: 1000 * GIB,
        };
        const snapshot: HostCapacitySnapshot = {
          sampledAt: 0,
          cpuUtilization: 0.1,
          cpuCount: 8,
          availableMemoryBytes: 8 * GIB,
          totalMemoryBytes: 16 * GIB,
          loadAvg: null,
          disk: home,
        };
        const live = HostPressureMonitor.layer.pipe(
          Layer.provide(
            Layer.mock(HostResources.HostResources)({
              read: Effect.succeed(snapshot),
              diskAt: (path) => Effect.succeed(path === worktrees ? fuller : home),
            }),
          ),
          Layer.provide(
            ServerSettings.ServerSettingsService.layerTest({ worktreesDirectory: worktrees }),
          ),
          Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "pressure-monitor-" })),
          Layer.provide(NodeServices.layer),
        );
        const disk = yield* Effect.gen(function* () {
          const monitor = yield* HostPressureMonitor.HostPressureMonitor;
          yield* every30s(7);
          return yield* monitor.disk.pipe(Stream.runHead);
        }).pipe(Effect.provide(live));
        expect(disk._tag === "Some" ? disk.value : null).toMatchObject({
          level: "elevated",
          path: worktrees,
          availableBytes: 20 * GIB,
        });
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped),
  );
});
