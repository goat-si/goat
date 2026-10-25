import type { HostDiskPressure, HostPressure } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { EventLoopMonitor } from "../../observability/EventLoopMonitor.ts";
import * as HostResources from "../../resourceTelemetry/HostResources.ts";
import * as ServerSettings from "../../serverSettings.ts";
import {
  diskOnlySample,
  initialPressureState,
  resolvePressureSettings,
  sampleFromCapacity,
  stepPressure,
  toHostPressure,
  type PressureSample,
  type PressureState,
} from "./pressureModel.ts";

/** Matches the event-loop monitor's timer, so every stall it records is seen once. */
export const PRESSURE_SAMPLE_INTERVAL_MS = 30_000;
/** A smaller change in free space is not news for clients showing it. */
const DISK_CHANGE_BYTES = 1024 ** 3;

const sameDiskReading = (left: HostDiskPressure | null, right: HostDiskPressure | null) =>
  left === null || right === null
    ? left === right
    : left.level === right.level &&
      left.path === right.path &&
      left.totalBytes === right.totalBytes &&
      Math.abs(left.availableBytes - right.availableBytes) < DISK_CHANGE_BYTES;

export interface HostPressureMonitorShape {
  /** This machine's pressure; undefined when fleet.pressure is off or before the first sample. */
  readonly current: Effect.Effect<HostPressure | undefined>;
  /** Takes one sample now. The live layer calls it every 30 s. */
  readonly sample: Effect.Effect<HostPressure | undefined>;
  /**
   * The disk's own level and free space: the current value, then each change of level or of at
   * least 1 GiB. Null while fleet.pressure is off, before the first sample, or when the host
   * reports no disk.
   */
  readonly disk: Stream.Stream<HostDiskPressure | null>;
}

/** This machine's resource pressure, classified with hysteresis from its own host metrics. */
export class HostPressureMonitor extends Context.Service<
  HostPressureMonitor,
  HostPressureMonitorShape
>()("goat/fleet/pressure/HostPressureMonitor") {}

export const make = Effect.fn("HostPressureMonitor.make")(function* (
  read: Effect.Effect<PressureSample>,
) {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const state = yield* Ref.make<PressureState | undefined>(undefined);
  const diskState = yield* Ref.make<PressureState | undefined>(undefined);
  const disk = yield* SubscriptionRef.make<HostDiskPressure | null>(null);
  const settings = settingsService.getSettings.pipe(
    Effect.map((value) => resolvePressureSettings(value.fleet.pressure)),
    Effect.orElseSucceed(() => resolvePressureSettings(undefined)),
  );
  const sample = Effect.fn("HostPressureMonitor.sample")(function* () {
    const resolved = yield* settings;
    if (!resolved.enabled) {
      yield* Ref.set(state, undefined);
      yield* Ref.set(diskState, undefined);
      if ((yield* SubscriptionRef.get(disk)) !== null) yield* SubscriptionRef.set(disk, null);
      return undefined;
    }
    const reading = yield* read;
    const now = yield* Clock.currentTimeMillis;
    const next = stepPressure(
      (yield* Ref.get(state)) ?? initialPressureState(now),
      reading,
      resolved,
      now,
    );
    yield* Ref.set(state, next);
    const diskNext = stepPressure(
      (yield* Ref.get(diskState)) ?? initialPressureState(now),
      diskOnlySample(reading),
      resolved,
      now,
    );
    yield* Ref.set(diskState, diskNext);
    const previous = yield* SubscriptionRef.get(disk);
    const current: HostDiskPressure | null =
      reading.diskAvailableBytes === null ||
      reading.diskTotalBytes === null ||
      reading.diskPath === undefined
        ? null
        : {
            level: diskNext.level,
            since: DateTime.formatIso(DateTime.makeUnsafe(diskNext.since)),
            path: reading.diskPath,
            availableBytes: reading.diskAvailableBytes,
            totalBytes: reading.diskTotalBytes,
          };
    if (!sameDiskReading(previous, current)) yield* SubscriptionRef.set(disk, current);
    return toHostPressure(next);
  });
  return HostPressureMonitor.of({
    current: Ref.get(state).pipe(
      Effect.map((value) => (value === undefined ? undefined : toHostPressure(value))),
    ),
    sample: sample(),
    disk: SubscriptionRef.changes(disk),
  });
});

/** Host metrics plus the event-loop stall recorded since the previous reading. */
const liveRead = Effect.gen(function* () {
  const resources = yield* HostResources.HostResources;
  const loop = yield* EventLoopMonitor;
  const seenStallAt = yield* Ref.make(Number.NEGATIVE_INFINITY);
  // @effect-diagnostics-next-line returnEffectInGen:off - the read effect is the result.
  return Effect.gen(function* () {
    const snapshot = yield* resources.read;
    const stall = yield* loop.latestStall;
    const fresh = stall !== undefined && stall.atMs > (yield* Ref.get(seenStallAt));
    if (stall !== undefined) yield* Ref.set(seenStallAt, stall.atMs);
    return sampleFromCapacity(snapshot, fresh ? stall.delayMs : null);
  });
});

export const layer = Layer.effect(
  HostPressureMonitor,
  Effect.gen(function* () {
    const monitor = yield* make(yield* liveRead);
    yield* monitor.sample.pipe(
      Effect.andThen(Effect.sleep(PRESSURE_SAMPLE_INTERVAL_MS)),
      Effect.forever,
      Effect.forkScoped,
    );
    return monitor;
  }),
);
