import {
  DesktopHostTelemetryMessage,
  PRIMARY_LOCAL_ENVIRONMENT_ID,
  type DesktopCuaAppsRequest,
  type DesktopCuaAppsReport,
  type DesktopCuaDriverRequest,
  type DesktopCuaDriverReport,
  type DesktopCuaFrame,
  type DesktopCuaFrames,
  type DesktopCuaReadinessReport,
  type DesktopCuaHumanInputReport,
  type DesktopCuaPrivateModeReport,
  type DesktopHostTelemetrySnapshot,
  type DesktopTelemetryControlMessage,
  type DesktopTelemetryCancelDesktopUpdate,
  type DesktopTelemetryCommitDesktopUpdate,
  type DesktopTelemetryRequestDesktopUpdate,
  type DesktopUpdateStatusReport,
  type HostPowerSnapshot,
} from "@goat/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ElectronApp from "../electron/ElectronApp.ts";
import * as ElectronPowerMonitor from "../electron/ElectronPowerMonitor.ts";
import * as DesktopRendererHistory from "./DesktopRendererHistory.ts";

const LIVE_SAMPLE_INTERVAL = Duration.seconds(1);
const BATTERY_SAMPLE_INTERVAL = Duration.seconds(5);
const CONSTRAINED_SAMPLE_INTERVAL = Duration.seconds(15);
const DEFAULT_HOST_POWER_ACTIVE_INTERVAL = Duration.seconds(30);
const DEFAULT_HOST_POWER_IDLE_INTERVAL = Duration.minutes(2);
const IDLE_THRESHOLD_SECONDS = 60;
const encodeMessage = Schema.encodeSync(Schema.fromJsonString(DesktopHostTelemetryMessage));
const textEncoder = new TextEncoder();

type PowerEvent =
  | { readonly type: "locked"; readonly value: boolean }
  | { readonly type: "suspended"; readonly value: boolean }
  | { readonly type: "onBattery"; readonly value: boolean }
  | { readonly type: "thermal"; readonly value: HostPowerSnapshot["thermalState"] }
  | { readonly type: "speedLimit"; readonly value: number };

interface PowerState {
  readonly idle: HostPowerSnapshot["idle"];
  readonly locked: HostPowerSnapshot["locked"];
  readonly lockedEventPending: boolean;
  readonly suspended: boolean;
  readonly suspendedEventPending: boolean;
  readonly onBattery: HostPowerSnapshot["onBattery"];
  readonly onBatteryEventPending: boolean;
  readonly thermalState: HostPowerSnapshot["thermalState"];
  readonly speedLimitPercent: Option.Option<number>;
}

interface HostPowerIntervals {
  readonly active: Duration.Duration;
  readonly idle: Duration.Duration;
}

export class DesktopTelemetryPublisher extends Context.Service<
  DesktopTelemetryPublisher,
  {
    readonly latest: Effect.Effect<Option.Option<DesktopHostTelemetrySnapshot>>;
    readonly changes: Stream.Stream<DesktopHostTelemetrySnapshot>;
    readonly encoded: Stream.Stream<Uint8Array>;
    readonly encodedForSource: (sourceId: string) => Stream.Stream<Uint8Array>;
    readonly cuaAppsRequests: Stream.Stream<DesktopCuaAppsRequest>;
    readonly publishCuaApps: (report: DesktopCuaAppsReport) => Effect.Effect<void>;
    readonly cuaRequests: Stream.Stream<DesktopCuaDriverRequest>;
    /**
     * Whether agents control this host, as this host's own server last said: the current value,
     * then each change. Losing that server reads as false.
     */
    readonly cuaWatch: Stream.Stream<boolean>;
    /** Approved named apps from the local server; cleared when it disconnects. */
    readonly cuaWatchApps: Stream.Stream<ReadonlyArray<string>>;
    /**
     * The windows this host's own server wants captured (#1370): the current request, then each
     * newer one. Losing that server reads as a request for none.
     */
    readonly cuaFrames: Stream.Stream<DesktopCuaFrames>;
    /** A frame or a no-picture answer, for this host's own server only; never replayed. */
    readonly publishCuaFrame: (frame: DesktopCuaFrame) => Effect.Effect<void>;
    readonly publishCuaReport: (report: DesktopCuaDriverReport) => Effect.Effect<void>;
    /**
     * The helper's readiness, for this host's own server only. The latest report goes to every
     * server connection that starts later, so a restarted server learns it without asking.
     */
    readonly publishCuaReadiness: (report: DesktopCuaReadinessReport) => Effect.Effect<void>;
    /**
     * The helper's safety reports, for this host's own server only and never dropped. A secret
     * field still focused is told again to a server that connects later, so its agents stay
     * paused.
     */
    readonly publishCuaSafety: (
      report: DesktopCuaPrivateModeReport | DesktopCuaHumanInputReport,
    ) => Effect.Effect<void>;
    readonly handleControlForSource: (
      sourceId: string,
      message: DesktopTelemetryControlMessage,
    ) => Effect.Effect<void>;
    readonly removeControlSource: (sourceId: string) => Effect.Effect<void>;
    readonly publishUpdateReport: (report: DesktopUpdateStatusReport) => Effect.Effect<void>;
    readonly updateRequests: Stream.Stream<DesktopTelemetryRequestDesktopUpdate>;
    readonly updateCommits: Stream.Stream<DesktopTelemetryCommitDesktopUpdate>;
    readonly updateCancellations: Stream.Stream<DesktopTelemetryCancelDesktopUpdate>;
  }
>()("@goat/desktop/telemetry/DesktopTelemetryPublisher") {}

function booleanState(value: boolean): HostPowerSnapshot["onBattery"] {
  return value ? "true" : "false";
}

function idleState(value: ElectronPowerMonitor.ElectronIdleState): HostPowerSnapshot["idle"] {
  switch (value) {
    case "active":
      return "false";
    case "idle":
    case "locked":
      return "true";
    case "unknown":
      return "unknown";
  }
}

function updatePowerState(state: PowerState, event: PowerEvent): PowerState {
  switch (event.type) {
    case "locked":
      return {
        ...state,
        locked: booleanState(event.value),
        lockedEventPending: true,
      };
    case "suspended":
      return {
        ...state,
        suspended: event.value,
        suspendedEventPending: event.value,
      };
    case "onBattery":
      return {
        ...state,
        onBattery: booleanState(event.value),
        onBatteryEventPending: true,
      };
    case "thermal":
      return { ...state, thermalState: event.value };
    case "speedLimit":
      return { ...state, speedLimitPercent: Option.some(event.value) };
  }
}

function sampleInterval(
  power: PowerState,
  diagnosticsDemand: boolean,
  hostPowerIntervals: HostPowerIntervals,
): Duration.Duration {
  if (!diagnosticsDemand) {
    return power.suspended || power.locked === "true" || power.idle === "true"
      ? hostPowerIntervals.idle
      : hostPowerIntervals.active;
  }
  if (
    power.suspended ||
    power.locked === "true" ||
    power.thermalState === "serious" ||
    power.thermalState === "critical"
  ) {
    return CONSTRAINED_SAMPLE_INTERVAL;
  }
  if (power.onBattery === "true") return BATTERY_SAMPLE_INTERVAL;
  return LIVE_SAMPLE_INTERVAL;
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.fn("desktop.telemetryPublisher.make")(function* () {
  const electronApp = yield* ElectronApp.ElectronApp;
  const powerMonitor = yield* ElectronPowerMonitor.ElectronPowerMonitor;
  const rendererHistory = yield* DesktopRendererHistory.DesktopRendererHistory;
  yield* electronApp.whenReady;

  const initialPowerState: PowerState = {
    idle: "unknown",
    locked: "unknown",
    lockedEventPending: false,
    suspended: false,
    suspendedEventPending: false,
    onBattery: booleanState(yield* powerMonitor.isOnBatteryPower),
    onBatteryEventPending: false,
    thermalState: yield* powerMonitor.getCurrentThermalState,
    speedLimitPercent: Option.none(),
  };
  const powerState = yield* Ref.make(initialPowerState);
  const hostPowerIntervals = yield* Ref.make<HostPowerIntervals>({
    active: DEFAULT_HOST_POWER_ACTIVE_INTERVAL,
    idle: DEFAULT_HOST_POWER_IDLE_INTERVAL,
  });
  const powerEvents = yield* Queue.unbounded<PowerEvent>();
  const sampleTriggers = yield* Queue.sliding<void>(1);
  const diagnosticsDemandSources = yield* Ref.make<ReadonlySet<string>>(new Set());
  const latest = yield* Ref.make(Option.none<DesktopHostTelemetrySnapshot>());
  const changes = yield* PubSub.sliding<DesktopHostTelemetrySnapshot>(8);
  const sequence = yield* Ref.make(0);
  const latestUpdateReport = yield* Ref.make(Option.none<DesktopUpdateStatusReport>());
  const updateReportChanges = yield* PubSub.sliding<DesktopUpdateStatusReport>(16);
  const updateRequestQueue = yield* Queue.unbounded<DesktopTelemetryRequestDesktopUpdate>();
  const updateCommitQueue = yield* Queue.unbounded<DesktopTelemetryCommitDesktopUpdate>();
  const updateCancellationQueue = yield* Queue.unbounded<DesktopTelemetryCancelDesktopUpdate>();
  const cuaAppsRequestQueue = yield* Queue.unbounded<DesktopCuaAppsRequest>();
  const cuaRequestQueue = yield* Queue.unbounded<DesktopCuaDriverRequest>();
  const latestCuaReadiness = yield* Ref.make(Option.none<DesktopCuaReadinessReport>());
  // Readiness is state: a connection that falls behind needs only the newest report.
  const cuaReadinessChanges = yield* PubSub.sliding<DesktopCuaReadinessReport>(1);
  const activePrivateMode = yield* Ref.make(Option.none<DesktopCuaPrivateModeReport>());
  const cuaSafetyReports = yield* PubSub.unbounded<
    DesktopCuaPrivateModeReport | DesktopCuaHumanInputReport
  >();
  interface CuaSource {
    readonly reports: PubSub.PubSub<DesktopCuaDriverReport | DesktopCuaAppsReport>;
    readonly appRequestIds: Set<string>;
    requestId?: string;
    /** The newest cuaWatch seq from this connection; an older one arrived late. */
    watchSeq?: number;
  }
  let cuaSource: CuaSource | undefined;
  const cuaWatching = yield* Ref.make(false);
  const cuaWatchChanges = yield* PubSub.sliding<boolean>(1);
  const setCuaWatching = (active: boolean) =>
    Ref.getAndSet(cuaWatching, active).pipe(
      Effect.flatMap((previous) =>
        previous === active ? Effect.void : PubSub.publish(cuaWatchChanges, active),
      ),
      Effect.asVoid,
    );
  const cuaWatchApps = yield* Ref.make<ReadonlyArray<string>>([]);
  const cuaWatchAppsChanges = yield* PubSub.sliding<ReadonlyArray<string>>(1);
  const setCuaWatchApps = Effect.fn("desktop.telemetryPublisher.setCuaWatchApps")(
    (apps: ReadonlyArray<string>) =>
      Ref.getAndSet(cuaWatchApps, apps).pipe(
        Effect.flatMap((previous) =>
          previous.length === apps.length && previous.every((app, i) => app === apps[i])
            ? Effect.void
            : PubSub.publish(cuaWatchAppsChanges, apps),
        ),
        Effect.asVoid,
      ),
  );
  const noFrames: DesktopCuaFrames = { version: 1, type: "cuaFrames", seq: 0, targets: [] };
  const cuaFramesRequest = yield* Ref.make(noFrames);
  const cuaFramesChanges = yield* PubSub.sliding<DesktopCuaFrames>(1);
  const setCuaFrames = (request: DesktopCuaFrames) =>
    Ref.set(cuaFramesRequest, request).pipe(
      Effect.andThen(PubSub.publish(cuaFramesChanges, request)),
      Effect.asVoid,
    );
  // Only the newest frame matters; a server that falls behind skips older ones.
  const cuaFramesOut = yield* PubSub.sliding<DesktopCuaFrame>(4);
  const detachCuaSource = Effect.fn("DesktopTelemetryPublisher.detachCuaSource")(function* (
    source: CuaSource,
  ) {
    if (cuaSource !== source) return;
    cuaSource = undefined;
    // No server, no agent controlling this host through it.
    yield* setCuaWatching(false);
    yield* setCuaWatchApps([]);
    // No server, nobody watching a window either.
    yield* setCuaFrames(noFrames);
    if (source.requestId)
      yield* Queue.offer(cuaRequestQueue, {
        version: 1,
        type: "cuaDriverRequest",
        requestId: source.requestId,
        enabled: false,
      });
  });

  const offer = (event: PowerEvent): void => {
    Queue.offerUnsafe(powerEvents, event);
  };
  yield* Effect.all(
    [
      powerMonitor.onSimpleEvent("lock-screen", () => offer({ type: "locked", value: true })),
      powerMonitor.onSimpleEvent("unlock-screen", () => offer({ type: "locked", value: false })),
      powerMonitor.onSimpleEvent("suspend", () => offer({ type: "suspended", value: true })),
      powerMonitor.onSimpleEvent("resume", () => offer({ type: "suspended", value: false })),
      powerMonitor.onSimpleEvent("on-battery", () => offer({ type: "onBattery", value: true })),
      powerMonitor.onSimpleEvent("on-ac", () => offer({ type: "onBattery", value: false })),
      powerMonitor.onThermalStateChange((value) => offer({ type: "thermal", value })),
      powerMonitor.onSpeedLimitChange((value) => offer({ type: "speedLimit", value })),
    ],
    { concurrency: "unbounded" },
  );
  yield* Effect.forever(
    Queue.take(powerEvents).pipe(
      Effect.flatMap((event) => Ref.update(powerState, (state) => updatePowerState(state, event))),
      Effect.andThen(Queue.offer(sampleTriggers, undefined)),
    ),
  ).pipe(Effect.forkScoped);

  const sampleOnce =
    /* Periodic telemetry sampling should not generate its own tracing traffic. */
    Effect.fnUntraced(
      function* (allowSuspendRecovery: boolean) {
        const sampledAt = yield* DateTime.now;
        const sampledAtUnixMs = DateTime.toEpochMillis(sampledAt);
        const demand = (yield* Ref.get(diagnosticsDemandSources)).size > 0;
        const [currentPower, idleSeconds, systemIdleState, onBattery, metrics] = yield* Effect.all(
          [
            Ref.get(powerState),
            powerMonitor.getSystemIdleTime,
            powerMonitor.getSystemIdleState(IDLE_THRESHOLD_SECONDS),
            powerMonitor.isOnBatteryPower,
            electronApp.getAppMetrics,
          ],
          { concurrency: "unbounded" },
        );
        // One Electron sampler preserves the shared CPU measurement interval.
        yield* rendererHistory.recordMetrics(metrics);
        const polledLocked =
          systemIdleState === "unknown"
            ? currentPower.locked
            : booleanState(systemIdleState === "locked");
        const polledOnBattery = booleanState(onBattery);
        const observedPower = yield* Ref.modify(powerState, (latestPower) => {
          const preserveEventLocked =
            latestPower.lockedEventPending ||
            latestPower.locked !== currentPower.locked ||
            latestPower.lockedEventPending !== currentPower.lockedEventPending;
          const preserveEventOnBattery =
            latestPower.onBatteryEventPending ||
            latestPower.onBattery !== currentPower.onBattery ||
            latestPower.onBatteryEventPending !== currentPower.onBatteryEventPending;
          const preserveEventSuspended =
            latestPower.suspendedEventPending ||
            latestPower.suspended !== currentPower.suspended ||
            latestPower.suspendedEventPending !== currentPower.suspendedEventPending;
          const next: PowerState = {
            ...latestPower,
            idle: idleState(systemIdleState),
            locked: preserveEventLocked ? latestPower.locked : polledLocked,
            lockedEventPending:
              latestPower.lockedEventPending &&
              (systemIdleState === "unknown" || polledLocked !== latestPower.locked),
            suspended:
              allowSuspendRecovery && !preserveEventSuspended ? false : latestPower.suspended,
            suspendedEventPending: false,
            onBattery: preserveEventOnBattery ? latestPower.onBattery : polledOnBattery,
            onBatteryEventPending:
              latestPower.onBatteryEventPending && polledOnBattery !== latestPower.onBattery,
          };
          return [next, next] as const;
        });
        const nextSequence = yield* Ref.modify(sequence, (current) => [current + 1, current + 1]);
        const snapshot: DesktopHostTelemetrySnapshot = {
          version: 1,
          type: "desktopTelemetry",
          sequence: nextSequence,
          sampledAtUnixMs,
          electronPid: process.pid,
          power: {
            source: "electron-main",
            idle: observedPower.idle,
            idleSeconds,
            locked: observedPower.locked,
            suspended: observedPower.suspended,
            onBattery: observedPower.onBattery,
            lowPowerMode: "unknown",
            thermalState: observedPower.thermalState,
            stale: false,
            updatedAt: sampledAt,
          },
          speedLimitPercent: observedPower.speedLimitPercent,
          electronProcesses: (demand ? metrics : []).map((metric) => ({
            pid: metric.pid,
            creationTimeMs: Math.max(0, Math.round(metric.creationTime)),
            type: metric.type,
            ...(metric.name === undefined ? {} : { name: metric.name }),
            ...(metric.serviceName === undefined ? {} : { serviceName: metric.serviceName }),
            cpuPercent: metric.cpu.percentCPUUsage,
            ...(metric.cpu.cumulativeCPUUsage === undefined
              ? {}
              : { cumulativeCpuSeconds: metric.cpu.cumulativeCPUUsage }),
            idleWakeupsPerSecond: metric.cpu.idleWakeupsPerSecond,
            workingSetBytes: Math.max(0, Math.round(metric.memory.workingSetSize * 1024)),
            peakWorkingSetBytes: Math.max(0, Math.round(metric.memory.peakWorkingSetSize * 1024)),
          })),
        };

        yield* Ref.set(latest, Option.some(snapshot));
        yield* PubSub.publish(changes, snapshot);
      },
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterrupts(cause),
        (cause) =>
          Effect.logWarning("Failed to sample Electron telemetry", {
            cause: String(cause),
          }),
      ),
    );

  yield* Effect.gen(function* () {
    yield* sampleOnce(false);
    while (true) {
      const [currentPower, demand, intervals] = yield* Effect.all([
        Ref.get(powerState),
        Ref.get(diagnosticsDemandSources).pipe(Effect.map((sources) => sources.size > 0)),
        Ref.get(hostPowerIntervals),
      ]);
      // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off - races a trigger queue against the interval; both arms are real outcomes, not a timeout
      const allowSuspendRecovery = yield* Effect.raceFirst(
        Queue.take(sampleTriggers).pipe(Effect.as(false)),
        Effect.sleep(sampleInterval(currentPower, demand, intervals)).pipe(Effect.as(true)),
      );
      yield* sampleOnce(allowSuspendRecovery);
    }
  }).pipe(Effect.forkScoped);

  const handleControlForSource: DesktopTelemetryPublisher["Service"]["handleControlForSource"] = (
    sourceId,
    message,
  ) => {
    switch (message.type) {
      case "cuaAppsRequest":
        return Effect.suspend(() => {
          if (sourceId !== PRIMARY_LOCAL_ENVIRONMENT_ID || !cuaSource) return Effect.void;
          cuaSource.appRequestIds.add(message.requestId);
          return Queue.offer(cuaAppsRequestQueue, message).pipe(Effect.asVoid);
        });
      case "cuaDriverRequest":
        return Effect.suspend(() => {
          if (sourceId !== PRIMARY_LOCAL_ENVIRONMENT_ID || !cuaSource) return Effect.void;
          cuaSource.requestId = message.requestId;
          return Queue.offer(cuaRequestQueue, message).pipe(Effect.asVoid);
        });
      case "setDiagnosticsDemand":
        return Ref.modify(diagnosticsDemandSources, (sources) => {
          const previous = sources.size > 0;
          const next = new Set(sources);
          if (message.enabled) {
            next.add(sourceId);
          } else {
            next.delete(sourceId);
          }
          return [[previous, next.size > 0] as const, next] as const;
        }).pipe(
          Effect.flatMap(([previous, enabled]) =>
            previous === enabled
              ? Effect.void
              : Queue.offer(sampleTriggers, undefined).pipe(Effect.asVoid),
          ),
        );
      case "setHostPowerIntervals":
        return Ref.set(hostPowerIntervals, {
          active: Duration.millis(message.activeIntervalMs),
          idle: Duration.millis(message.idleIntervalMs),
        }).pipe(Effect.andThen(Queue.offer(sampleTriggers, undefined)), Effect.asVoid);
      case "requestDesktopUpdate":
        return Queue.offer(updateRequestQueue, message).pipe(Effect.asVoid);
      case "commitDesktopUpdate":
        return Queue.offer(updateCommitQueue, message).pipe(Effect.asVoid);
      case "cancelDesktopUpdate":
        return Queue.offer(updateCancellationQueue, message).pipe(Effect.asVoid);
      case "cuaWatch":
        return Effect.suspend(() => {
          const source = cuaSource;
          if (sourceId !== PRIMARY_LOCAL_ENVIRONMENT_ID || !source) return Effect.void;
          if (source.watchSeq !== undefined && message.seq < source.watchSeq) return Effect.void;
          source.watchSeq = message.seq;
          return setCuaWatching(message.active).pipe(
            Effect.andThen(
              setCuaWatchApps(message.active ? [...new Set(message.apps ?? [])].sort() : []),
            ),
          );
        });
      case "cuaFrames":
        return Effect.suspend(() => {
          if (sourceId !== PRIMARY_LOCAL_ENVIRONMENT_ID || !cuaSource) return Effect.void;
          return Ref.get(cuaFramesRequest).pipe(
            // A request older than the one in force arrived late.
            Effect.flatMap((current) =>
              message.seq < current.seq ? Effect.void : setCuaFrames(message),
            ),
          );
        });
    }
  };
  const removeControlSource: DesktopTelemetryPublisher["Service"]["removeControlSource"] =
    Effect.fn("DesktopTelemetryPublisher.removeControlSource")(function* (sourceId) {
      if (sourceId === PRIMARY_LOCAL_ENVIRONMENT_ID && cuaSource) {
        yield* detachCuaSource(cuaSource);
      }
      yield* Ref.modify(diagnosticsDemandSources, (sources) => {
        const previous = sources.size > 0;
        const next = new Set(sources);
        next.delete(sourceId);
        return [[previous, next.size > 0] as const, next] as const;
      }).pipe(
        Effect.flatMap(([previous, enabled]) =>
          previous === enabled
            ? Effect.void
            : Queue.offer(sampleTriggers, undefined).pipe(Effect.asVoid),
        ),
      );
    });

  const snapshots = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(changes);
      const initial = yield* Ref.get(latest);
      return Stream.concat(
        Option.match(initial, {
          onNone: () => Stream.empty,
          onSome: Stream.make,
        }),
        Stream.fromSubscription(subscription),
      );
    }),
  );
  const updateReports = Stream.unwrap(
    Effect.gen(function* () {
      const subscription = yield* PubSub.subscribe(updateReportChanges);
      const initial = yield* Ref.get(latestUpdateReport);
      return Stream.concat(
        Option.match(initial, {
          onNone: () => Stream.empty,
          onSome: Stream.make,
        }),
        Stream.fromSubscription(subscription),
      );
    }),
  );
  const encoded = Stream.concat(
    Stream.make({
      version: 1,
      type: "desktopTelemetryHello",
      electronPid: process.pid,
    } as const),
    Stream.merge(snapshots, updateReports),
  ).pipe(Stream.map((message) => textEncoder.encode(`${encodeMessage(message)}\n`)));

  const publishUpdateReport: DesktopTelemetryPublisher["Service"]["publishUpdateReport"] = (
    report,
  ) =>
    Ref.set(latestUpdateReport, Option.some(report)).pipe(
      Effect.andThen(PubSub.publish(updateReportChanges, report)),
      Effect.asVoid,
    );

  const encodedForSource = (sourceId: string): Stream.Stream<Uint8Array> => {
    if (sourceId !== PRIMARY_LOCAL_ENVIRONMENT_ID) return encoded;
    return Stream.unwrap(
      Effect.gen(function* () {
        const reports = yield* PubSub.unbounded<DesktopCuaDriverReport | DesktopCuaAppsReport>();
        const source: CuaSource = { reports, appRequestIds: new Set() };
        yield* Effect.acquireRelease(
          Effect.gen(function* () {
            if (cuaSource) yield* detachCuaSource(cuaSource);
            cuaSource = source;
          }),
          () => detachCuaSource(source),
        );
        const subscription = yield* PubSub.subscribe(reports);
        const privateReports = Stream.fromSubscription(subscription).pipe(
          Stream.filter(() => cuaSource === source),
          Stream.map((message) => textEncoder.encode(`${encodeMessage(message)}\n`)),
        );
        const readinessSubscription = yield* PubSub.subscribe(cuaReadinessChanges);
        const readiness = Stream.concat(
          Option.match(yield* Ref.get(latestCuaReadiness), {
            onNone: () => Stream.empty,
            onSome: Stream.make,
          }),
          Stream.fromSubscription(readinessSubscription),
        ).pipe(Stream.map((message) => textEncoder.encode(`${encodeMessage(message)}\n`)));
        const safetySubscription = yield* PubSub.subscribe(cuaSafetyReports);
        const safety = Stream.concat(
          Option.match(yield* Ref.get(activePrivateMode), {
            onNone: () => Stream.empty,
            onSome: Stream.make,
          }),
          Stream.fromSubscription(safetySubscription),
        ).pipe(Stream.map((message) => textEncoder.encode(`${encodeMessage(message)}\n`)));
        const framesSubscription = yield* PubSub.subscribe(cuaFramesOut);
        const frames = Stream.fromSubscription(framesSubscription).pipe(
          Stream.filter(() => cuaSource === source),
          Stream.map((message) => textEncoder.encode(`${encodeMessage(message)}\n`)),
        );
        return Stream.mergeAll([encoded, privateReports, readiness, safety, frames], {
          concurrency: "unbounded",
        });
      }),
    );
  };

  return DesktopTelemetryPublisher.of({
    latest: Ref.get(latest),
    changes: Stream.fromPubSub(changes),
    encoded,
    encodedForSource,
    cuaAppsRequests: Stream.fromQueue(cuaAppsRequestQueue),
    publishCuaApps: (report) =>
      Effect.suspend(() =>
        cuaSource?.appRequestIds.delete(report.requestId)
          ? PubSub.publish(cuaSource.reports, report).pipe(Effect.asVoid)
          : Effect.void,
      ),
    cuaRequests: Stream.fromQueue(cuaRequestQueue),
    cuaWatch: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(cuaWatchChanges);
        return Stream.concat(
          Stream.make(yield* Ref.get(cuaWatching)),
          Stream.fromSubscription(subscription),
        );
      }),
    ),
    cuaWatchApps: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(cuaWatchAppsChanges);
        return Stream.concat(
          Stream.make(yield* Ref.get(cuaWatchApps)),
          Stream.fromSubscription(subscription),
        );
      }),
    ),
    cuaFrames: Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(cuaFramesChanges);
        return Stream.concat(
          Stream.make(yield* Ref.get(cuaFramesRequest)),
          Stream.fromSubscription(subscription),
        );
      }),
    ),
    publishCuaFrame: (frame) => PubSub.publish(cuaFramesOut, frame).pipe(Effect.asVoid),
    publishCuaReport: (report) =>
      Effect.suspend(() =>
        cuaSource && cuaSource.requestId === report.requestId
          ? PubSub.publish(cuaSource.reports, report).pipe(Effect.asVoid)
          : Effect.void,
      ),
    publishCuaReadiness: (report) =>
      Ref.set(latestCuaReadiness, Option.some(report)).pipe(
        Effect.andThen(PubSub.publish(cuaReadinessChanges, report)),
        Effect.asVoid,
      ),
    publishCuaSafety: (report) =>
      (report.type === "cuaPrivateMode"
        ? Ref.set(activePrivateMode, report.active ? Option.some(report) : Option.none())
        : Effect.void
      ).pipe(Effect.andThen(PubSub.publish(cuaSafetyReports, report)), Effect.asVoid),
    handleControlForSource,
    removeControlSource,
    publishUpdateReport,
    updateRequests: Stream.fromQueue(updateRequestQueue),
    updateCommits: Stream.fromQueue(updateCommitQueue),
    updateCancellations: Stream.fromQueue(updateCancellationQueue),
  });
});

export const layer = Layer.effect(DesktopTelemetryPublisher, make());
