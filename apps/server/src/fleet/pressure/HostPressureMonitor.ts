import type { HostDiskPressure, HostDiskUsage, HostPressure } from "@goat/contracts";
// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as HostProcess from "@goat/shared/HostProcess";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as ServerConfig from "../../config.ts";
import { EventLoopMonitor } from "../../observability/EventLoopMonitor.ts";
import * as HostResources from "../../resourceTelemetry/HostResources.ts";
import * as ServerSettings from "../../serverSettings.ts";
import { managedWorktreesDirectories } from "../../worktreesDirectory.ts";
import {
  combineHostPressure,
  diskOnlySample,
  initialPressureState,
  mostPressedDisk,
  nonDiskSample,
  resolvePressureSettings,
  restartEvidence,
  sampleFromCapacity,
  stepPressure,
  type PressureSample,
  type PressureState,
} from "./pressureModel.ts";

/** How often this machine is sampled while someone is asking, and how old a reading may get. */
export const PRESSURE_SAMPLE_INTERVAL_MS = 30_000;
/** Sampling continues this long after the last read, then stops until someone asks again. */
const PRESSURE_DEMAND_MS = 2 * 60_000;
/** A longer gap between readings restarts the evidence that a level held. */
const PRESSURE_GAP_MS = 3 * PRESSURE_SAMPLE_INTERVAL_MS;
/** A smaller change in free space is not news for clients showing it. */
const DISK_CHANGE_BYTES = 1024 ** 3;

const sameDiskReading = (left: HostDiskPressure | null, right: HostDiskPressure | null) =>
  left === null || right === null
    ? left === right
    : left.level === right.level &&
      left.path === right.path &&
      left.totalBytes === right.totalBytes &&
      Math.abs(left.availableBytes - right.availableBytes) < DISK_CHANGE_BYTES;

const diskVolumeKey = (sample: PressureSample) =>
  sample.diskDeviceId !== undefined && sample.diskDeviceId > 0
    ? `device:${sample.diskDeviceId}`
    : sample.diskPath === undefined
      ? null
      : `path:${sample.diskPath}`;

export interface HostPressureMonitorShape {
  /**
   * This machine's pressure from the held reading; undefined when fleet.pressure is off or before
   * the first sample. It answers at once and keeps sampling every 30 s for two minutes after, so
   * an idle server that nobody asks samples nothing.
   */
  readonly current: Effect.Effect<HostPressure | undefined>;
  /** The held reading without asking for a fresh one; for pollers that must not keep sampling alive. */
  readonly held: Effect.Effect<HostPressure | undefined>;
  /** Takes one sample now and waits for it. */
  readonly sample: Effect.Effect<HostPressure | undefined>;
  /**
   * The disk's own level and free space: the current value, then each change of level or of at
   * least 1 GiB. Null while fleet.pressure is off, before the first sample, or when the host
   * reports no disk. While watched, free space alone is read every 30 s.
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
  options: {
    /** Free space alone, for disk watchers: a statfs per volume, no process and no memory read. */
    readonly readDisk?: Effect.Effect<PressureSample>;
    /** Off only for tests that drive every sample themselves. */
    readonly background?: boolean;
  } = {},
) {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const layerScope = yield* Effect.scope;
  /** One reading at a time. askedAt keeps full samples going; diskWatchers keeps disk reads going. */
  const sampling = yield* Ref.make({
    running: false,
    startedAt: Number.NEGATIVE_INFINITY,
    askedAt: Number.NEGATIVE_INFINITY,
    diskWatchers: 0,
  });
  /** When each level last got a reading; a longer gap restarts its evidence. */
  const readAt = yield* Ref.make({ all: Number.NEGATIVE_INFINITY, disk: Number.NEGATIVE_INFINITY });
  const state = yield* Ref.make<PressureState | undefined>(undefined);
  const diskState = yield* Ref.make<PressureState | undefined>(undefined);
  const diskVolume = yield* Ref.make<string | null | undefined>(undefined);
  const disk = yield* SubscriptionRef.make<HostDiskPressure | null>(null);
  const settings = settingsService.getSettings.pipe(
    Effect.map((value) => resolvePressureSettings(value.fleet.pressure)),
    Effect.orElseSucceed(() => resolvePressureSettings(undefined)),
  );
  const turnedOff = Effect.gen(function* () {
    yield* Ref.set(state, undefined);
    yield* Ref.set(diskState, undefined);
    yield* Ref.set(diskVolume, undefined);
    if ((yield* SubscriptionRef.get(disk)) !== null) yield* SubscriptionRef.set(disk, null);
  });
  // Readings taken minutes apart do not show that a level held in between.
  const afterGap = (held: PressureState | undefined, previousAt: number, now: number) =>
    held !== undefined && now - previousAt > PRESSURE_GAP_MS ? restartEvidence(held) : held;

  const stepDisk = Effect.fnUntraced(function* (
    reading: PressureSample,
    resolved: ReturnType<typeof resolvePressureSettings>,
    now: number,
    previousAt: number,
  ) {
    const volume = diskVolumeKey(reading);
    const previousVolume = yield* Ref.get(diskVolume);
    // A recovery hold belongs to one volume, not the next disk chosen by mostPressedDisk.
    const held =
      previousVolume !== undefined && previousVolume !== volume
        ? undefined
        : afterGap(yield* Ref.get(diskState), previousAt, now);
    yield* Ref.set(diskVolume, volume);
    const diskNext = stepPressure(
      held ?? initialPressureState(now),
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
    return diskNext;
  });

  const sample = Effect.fn("HostPressureMonitor.sample")(function* () {
    const startedAt = yield* Clock.currentTimeMillis;
    yield* Ref.update(sampling, (current) => ({ ...current, startedAt }));
    const resolved = yield* settings;
    if (!resolved.enabled) {
      yield* turnedOff;
      return undefined;
    }
    const reading = yield* read;
    const now = yield* Clock.currentTimeMillis;
    const previous = yield* Ref.getAndSet(readAt, { all: now, disk: now });
    const next = stepPressure(
      afterGap(yield* Ref.get(state), previous.all, now) ?? initialPressureState(now),
      nonDiskSample(reading),
      resolved,
      now,
    );
    yield* Ref.set(state, next);
    const diskNext = yield* stepDisk(reading, resolved, now, previous.disk);
    return combineHostPressure(next, diskNext);
  });

  const sampleDisk = Effect.fn("HostPressureMonitor.sampleDisk")(function* (
    readDisk: Effect.Effect<PressureSample>,
  ) {
    const resolved = yield* settings;
    if (!resolved.enabled) return yield* turnedOff;
    const reading = yield* readDisk;
    const now = yield* Clock.currentTimeMillis;
    const previous = yield* Ref.getAndUpdate(readAt, (current) => ({ ...current, disk: now }));
    yield* stepDisk(reading, resolved, now, previous.disk);
  });

  const held = Effect.gen(function* () {
    const nonDisk = yield* Ref.get(state);
    const diskHeld = yield* Ref.get(diskState);
    return nonDisk === undefined || diskHeld === undefined
      ? undefined
      : combineHostPressure(nonDisk, diskHeld);
  });

  /** Claim and fork in one step, so an interrupted caller never strands the claim. */
  const runIfDue = (
    work: Effect.Effect<unknown>,
    due: (now: number, lastReadings: { readonly all: number; readonly disk: number }) => boolean,
    ask: boolean,
  ) =>
    Effect.uninterruptible(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const lastReadings = yield* Ref.get(readAt);
        const claimed = yield* Ref.modify(sampling, (current) => {
          const asked = ask ? { ...current, askedAt: now } : current;
          return !current.running &&
            now - current.startedAt >= PRESSURE_SAMPLE_INTERVAL_MS &&
            due(now, lastReadings)
            ? [true, { ...asked, running: true }]
            : [false, asked];
        });
        if (!claimed) return;
        yield* work.pipe(
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterrupts(cause),
            (cause) => Effect.logWarning("Host pressure reading failed", { cause }),
          ),
          Effect.ensuring(Ref.update(sampling, (current) => ({ ...current, running: false }))),
          Effect.forkIn(layerScope),
        );
      }),
    );
  const sampleIfStale = (ask: boolean) => runIfDue(sample(), () => true, ask);
  const diskIfStale =
    options.readDisk === undefined
      ? Effect.void
      : runIfDue(
          sampleDisk(options.readDisk),
          (now, lastReadings) => now - lastReadings.disk >= PRESSURE_SAMPLE_INTERVAL_MS,
          false,
        );

  // Like an agent cache's background refresh: full samples run while readers keep asking or a
  // raised level still has to recover; an open disk watcher gets free space alone. The timer
  // itself reads nothing.
  if (options.background !== false)
    yield* Effect.gen(function* () {
      yield* Effect.sleep(PRESSURE_SAMPLE_INTERVAL_MS);
      const { askedAt, diskWatchers } = yield* Ref.get(sampling);
      const now = yield* Clock.currentTimeMillis;
      const raised = (yield* held)?.level ?? "ok";
      if (now - askedAt < PRESSURE_DEMAND_MS || raised !== "ok") yield* sampleIfStale(false);
      else if (diskWatchers > 0) yield* diskIfStale;
    }).pipe(Effect.forever, Effect.forkIn(layerScope));

  const watchDisk = Effect.acquireRelease(
    Ref.update(sampling, (current) => ({ ...current, diskWatchers: current.diskWatchers + 1 })),
    () =>
      Ref.update(sampling, (current) => ({ ...current, diskWatchers: current.diskWatchers - 1 })),
  );
  return HostPressureMonitor.of({
    // Readers never wait on vm_stat or statfs; a stale reading refreshes behind them.
    current: held.pipe(Effect.tap(() => sampleIfStale(true))),
    held,
    sample: sample(),
    disk: Stream.unwrap(
      watchDisk.pipe(Effect.andThen(diskIfStale), Effect.as(SubscriptionRef.changes(disk))),
    ),
  });
});

/** Settings' worktree folders that exist, whose volumes GOAT fills besides its home. */
const worktreeDisks = Effect.gen(function* () {
  const resources = yield* HostResources.HostResources;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* HostProcess.HomeDirectory;
  const platform = yield* HostProcess.Platform;
  return (homeDisk: HostDiskUsage | null) =>
    Effect.gen(function* () {
      const settings = yield* settingsService.getSettings.pipe(Effect.option);
      const disks = homeDisk === null ? [] : [homeDisk];
      if (settings._tag === "Some")
        for (const folder of managedWorktreesDirectories(
          settings.value,
          config.worktreesDir,
          path,
          home,
          platform,
        )) {
          if (!(yield* fs.exists(folder).pipe(Effect.orElseSucceed(() => false)))) continue;
          const disk = yield* resources.diskAt(folder);
          if (disk !== null) disks.push(disk);
        }
      const disk = mostPressedDisk(
        disks,
        resolvePressureSettings(
          settings._tag === "Some" ? settings.value.fleet.pressure : undefined,
        ),
      );
      const diskDeviceId =
        disk === null
          ? undefined
          : yield* Effect.promise(() =>
              NodeFSP.stat(disk.path).then(
                (stats) => stats.dev,
                () => undefined,
              ),
            );
      return { disk, diskDeviceId };
    });
});

/**
 * Host metrics plus the event-loop stall recorded since the previous reading, and free space
 * alone for disk watchers. The disk is the most pressed of GOAT's home volume and the volumes of
 * its worktree folders, which Settings can put on another drive.
 */
const liveReads = Effect.gen(function* () {
  const resources = yield* HostResources.HostResources;
  const loop = yield* EventLoopMonitor;
  const config = yield* ServerConfig.ServerConfig;
  const disks = yield* worktreeDisks;
  const seenStallAt = yield* Ref.make(Number.NEGATIVE_INFINITY);
  const read = Effect.gen(function* () {
    const snapshot = yield* resources.read;
    const stall = yield* loop.latestStall;
    const now = yield* Clock.currentTimeMillis;
    // Only the latest stall is kept between readings; one older than a reading gap is history.
    const fresh =
      stall !== undefined &&
      stall.atMs > (yield* Ref.get(seenStallAt)) &&
      now - stall.atMs <= PRESSURE_GAP_MS;
    if (stall !== undefined) yield* Ref.set(seenStallAt, stall.atMs);
    const { disk, diskDeviceId } = yield* disks(snapshot.disk);
    return {
      ...sampleFromCapacity({ ...snapshot, disk }, fresh ? stall.delayMs : null),
      diskDeviceId,
    };
  });
  const readDisk = Effect.gen(function* () {
    const { disk, diskDeviceId } = yield* disks(yield* resources.diskAt(config.baseDir));
    return {
      loadPerCore: null,
      cpuUtilization: null,
      memoryFreeRatio: null,
      diskAvailableBytes: disk?.availableBytes ?? null,
      diskTotalBytes: disk?.totalBytes ?? null,
      diskPath: disk?.path,
      diskDeviceId,
      eventLoopDelayMs: null,
    } satisfies PressureSample;
  });
  return { read, readDisk };
});

export const layer = Layer.effect(
  HostPressureMonitor,
  Effect.gen(function* () {
    const { read, readDisk } = yield* liveReads;
    return yield* make(read, { readDisk });
  }),
);
