import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSettings from "../../serverSettings.ts";
import * as HostPressureMonitor from "./HostPressureMonitor.ts";
import type { PressureSample } from "./pressureModel.ts";

const reading = (loadPerCore: number): PressureSample => ({
  loadPerCore,
  cpuUtilization: 0.5,
  memoryFreeRatio: 0.5,
  diskAvailableBytes: 100 * 1024 ** 3,
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
  it.effect("raises the level after two minutes of load on the clock", () =>
    Effect.gen(function* () {
      expect(yield* every30s(5)).toEqual(["ok", "ok", "ok", "ok", "elevated"]);
      const current = yield* Effect.flatMap(
        HostPressureMonitor.HostPressureMonitor,
        (monitor) => monitor.current,
      );
      expect(current).toEqual({
        level: "elevated",
        since: "1970-01-01T00:02:00.000Z",
        reasons: [
          { signal: "load", level: "elevated", message: "load 2 per core (threshold 1.5)" },
        ],
        loadPerCore: 2,
        eventLoopDelayMs: null,
      });
    }).pipe(Effect.provide(layer(Array.from({ length: 5 }, () => reading(2))))),
  );

  it.effect("reports nothing when fleet.pressure.enabled is false", () =>
    Effect.gen(function* () {
      expect(yield* every30s(2)).toEqual([undefined, undefined]);
    }).pipe(Effect.provide(layer([reading(9), reading(9)], false))),
  );
});
