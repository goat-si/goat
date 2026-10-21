import {
  CommandId,
  MessageId,
  ThreadId,
  type GoatHostStatusResult,
  type HostPlacementRanking,
  type HostPlacementRequirements,
  type HostPressure,
  type HostPressureAdvice,
  type HostPressureDelivery,
  type HostStatusEntry,
  type OrchestrationV2ThreadShell,
} from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as HostStatusMcpService from "../../mcp/HostStatusMcpService.ts";
import * as LaunchWatchService from "../../mcp/LaunchWatchService.ts";
import * as ThreadManagementService from "../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as HostHealthMonitor from "../health/HostHealthMonitor.ts";
import * as HostPressureMonitor from "./HostPressureMonitor.ts";
import {
  initialPressureState,
  launchAdvice,
  NOTHING_ANNOUNCED,
  nudgeDecision,
  pressureHostKey,
  pressureNudgeText,
  pressureRecipients,
  rankHosts,
  resolvePressureSettings,
  roomyHosts,
  sampleFromEntry,
  stepPressure,
  toHostPressure,
  type AnnouncedPressure,
  type PressureNudgeKind,
  type PressureState,
  type ResolvedPressureSettings,
} from "./pressureModel.ts";

const PRESSURE_NUDGE_INTERVAL_MS = 60_000;
/** A remote reading older than this says nothing about the host now. */
const PRESSURE_READING_MAX_AGE_MS = 3 * 60_000;
const WATCH_SCAN_LIMIT = 200;

export interface PressureAdmission {
  readonly advice: HostPressureAdvice | undefined;
  /** fleet.pressure.admission is "block" and the host is critical. */
  readonly refuse: boolean;
}

export interface PressureNudgerShape {
  /** Records each host's pressure from a goat_host_status answer. */
  readonly observe: (result: GoatHostStatusResult) => Effect.Effect<void>;
  /** What a launch onto this host should be told, from readings this machine already has. */
  readonly admit: (host: string | null) => Effect.Effect<PressureAdmission>;
  /** Ranks the hosts of a status answer for one new lane. */
  readonly rank: (
    hosts: ReadonlyArray<HostStatusEntry>,
    requirements: HostPlacementRequirements,
  ) => Effect.Effect<HostPlacementRanking>;
  /** One pass: reads pressure where this machine's threads run work and tells their orchestrators. */
  readonly tick: Effect.Effect<void>;
}

/** Tells orchestrating threads when a host they run work on comes under pressure (ADR-0020). */
export class PressureNudger extends Context.Service<PressureNudger, PressureNudgerShape>()(
  "goat/fleet/pressure/PressureNudger",
) {}

interface RemoteReading {
  readonly entry: HostStatusEntry;
  readonly at: number;
  /** Stepped here for a host that predates reporting its own pressure. */
  readonly state: PressureState | null;
}

const deliveryFor = (
  settings: ResolvedPressureSettings,
  kind: PressureNudgeKind,
  level: HostPressure["level"],
  previous: HostPressure["level"],
): HostPressureDelivery => {
  if (kind === "rise")
    return level === "critical" ? settings.criticalDelivery : settings.elevatedDelivery;
  // Easing and recovery never start a turn; they are dropped where the rise was not delivered.
  const announced = previous === "critical" ? settings.criticalDelivery : settings.elevatedDelivery;
  return announced === "off" ? "off" : "notice";
};

/** Shared cached admission state; construction does not depend on watches or host-status reads. */
export class PressureAdmissionService extends Context.Service<
  PressureAdmissionService,
  {
    readonly observe: PressureNudgerShape["observe"];
    readonly admit: PressureNudgerShape["admit"];
    readonly pressureOf: (host: string | null) => Effect.Effect<HostPressure | undefined>;
    readonly freshEntries: Effect.Effect<ReadonlyArray<HostStatusEntry>>;
  }
>()("goat/fleet/pressure/PressureNudger/PressureAdmissionService") {}

const makeAdmission = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const monitor = yield* HostPressureMonitor.HostPressureMonitor;
  const readings = yield* Ref.make(new Map<string, RemoteReading>());
  const settings = settingsService.getSettings.pipe(
    Effect.map((value) => resolvePressureSettings(value.fleet.pressure)),
    Effect.orElseSucceed(() => resolvePressureSettings(undefined)),
  );

  const observe = Effect.fn("PressureNudger.observe")(function* (result: GoatHostStatusResult) {
    const resolved = yield* settings;
    const now = yield* Clock.currentTimeMillis;
    yield* Ref.update(readings, (current) => {
      const next = new Map(current);
      for (const entry of result.hosts) {
        if (entry.reachability !== "ok" || entry.lastKnown === true) continue;
        const key = pressureHostKey(entry.host);
        const sample = entry.pressure === undefined ? sampleFromEntry(entry) : null;
        const previous = current.get(key)?.state ?? null;
        next.set(key, {
          entry,
          at: now,
          state:
            sample === null
              ? null
              : stepPressure(previous ?? initialPressureState(now), sample, resolved, now),
        });
      }
      return next;
    });
  });

  const pressureOf = Effect.fn("PressureNudger.pressureOf")(function* (host: string | null) {
    if (host === null) return yield* monitor.current;
    const now = yield* Clock.currentTimeMillis;
    const reading = (yield* Ref.get(readings)).get(pressureHostKey(host));
    if (reading === undefined || now - reading.at > PRESSURE_READING_MAX_AGE_MS) return undefined;
    return (
      reading.entry.pressure ?? (reading.state === null ? undefined : toHostPressure(reading.state))
    );
  });

  const freshEntries = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return [...(yield* Ref.get(readings)).values()]
      .filter((reading) => now - reading.at <= PRESSURE_READING_MAX_AGE_MS)
      .map((reading) => reading.entry);
  });

  const admit = Effect.fn("PressureNudger.admit")(function* (
    host: string | null,
  ): Effect.fn.Return<PressureAdmission> {
    const resolved = yield* settings;
    if (!resolved.enabled || resolved.admission === "off")
      return { advice: undefined, refuse: false };
    const pressure = yield* pressureOf(host);
    if (pressure === undefined || pressure.level === "ok")
      return { advice: undefined, refuse: false };
    const now = yield* Clock.currentTimeMillis;
    const advice = launchAdvice({
      host,
      pressure,
      alternatives: roomyHosts(yield* freshEntries, host, resolved, now),
    });
    return {
      advice,
      refuse: resolved.admission === "block" && pressure.level === "critical",
    };
  });

  return PressureAdmissionService.of({ observe, admit, pressureOf, freshEntries });
});
export const layerAdmission = Layer.effect(PressureAdmissionService, makeAdmission);

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const { observe, admit, pressureOf, freshEntries } = yield* PressureAdmissionService;
  const hostStatus = yield* HostStatusMcpService.HostStatusMcpService;
  const watches = yield* LaunchWatchService.LaunchWatchService;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const health = yield* Effect.serviceOption(HostHealthMonitor.HostHealthMonitor);
  const announced = yield* Ref.make(new Map<string, AnnouncedPressure>());

  const settings = settingsService.getSettings.pipe(
    Effect.map((value) => resolvePressureSettings(value.fleet.pressure)),
    Effect.orElseSucceed(() => resolvePressureSettings(undefined)),
  );

  // Every connected host, as a read-only client with this machine's keys, like fleet placement.
  const readAll = Effect.gen(function* () {
    const descriptor = yield* environment.getDescriptor;
    const result = yield* hostStatus
      .readForClient({
        environmentId: descriptor.environmentId,
        sessionId: "fleet-pressure",
        reachHosts: true,
      })
      .pipe(Effect.orElseSucceed((): GoatHostStatusResult => ({ hosts: [] })));
    const annotated = health._tag === "Some" ? yield* health.value.annotate(result) : result;
    yield* observe(annotated);
    return annotated;
  });

  const deliver = (
    threadId: ThreadId,
    delivery: HostPressureDelivery,
    key: string,
    message: { readonly text: string; readonly summary: string },
  ) =>
    (delivery === "wake"
      ? threads.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("server:" + key),
          threadId,
          messageId: MessageId.make("message:" + key),
          text: message.text,
          notification: {
            source: { kind: "monitor" },
            outcome: "updated",
            summary: message.summary,
          },
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        })
      : threads.dispatch({
          type: "thread.notice.record",
          commandId: CommandId.make("server:" + key),
          threadId,
          recordKey: key,
          message: message.text,
        })
    ).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Effect.logWarning("fleet.pressure.notice-failed", { threadId, cause }),
      ),
    );

  const tick = Effect.gen(function* () {
    const resolved = yield* settings;
    if (!resolved.enabled) return;
    const active = (yield* watches
      .listRemote(WATCH_SCAN_LIMIT)
      .pipe(Effect.orElseSucceed(() => []))).filter((watch) => watch.pendingRuns.length > 0);
    const remoteHosts = [
      ...new Set(active.flatMap((watch) => (watch.host === null ? [] : [watch.host]))),
    ].toSorted();
    let entries: ReadonlyArray<HostStatusEntry> | null = null;
    if (remoteHosts.length > 0) entries = (yield* readAll).hosts;
    let shells: ReadonlyArray<OrchestrationV2ThreadShell> | null = null;
    const descriptor = yield* environment.getDescriptor;
    for (const host of [null, ...remoteHosts]) {
      const pressure = yield* pressureOf(host);
      if (pressure === undefined) continue;
      const key = pressureHostKey(host);
      const now = yield* Clock.currentTimeMillis;
      const before = (yield* Ref.get(announced)).get(key) ?? NOTHING_ANNOUNCED;
      const decision = nudgeDecision(before, pressure.level, now, resolved.notifyCooldownMs);
      yield* Ref.update(announced, (current) => new Map(current).set(key, decision.next));
      if (decision.kind === null) continue;
      const delivery = deliveryFor(resolved, decision.kind, pressure.level, before.level);
      if (delivery === "off") continue;
      shells ??= yield* threads
        .listProjectThreads({ projectId: undefined, includeSubagents: true })
        .pipe(Effect.orElseSucceed(() => []));
      const routed = pressureRecipients({
        host,
        environmentId: descriptor.environmentId,
        shells,
        watches: active,
      });
      if (routed.recipients.length === 0) continue;
      if (decision.kind !== "recover" && entries === null) entries = (yield* readAll).hosts;
      const alternatives =
        decision.kind === "recover"
          ? []
          : roomyHosts(entries ?? (yield* freshEntries), host, resolved, now);
      yield* Effect.logInfo("fleet.pressure.notice", {
        host: key,
        level: pressure.level,
        kind: decision.kind,
        recipients: routed.recipients.length,
      });
      yield* Effect.forEach(
        routed.recipients,
        (recipient) =>
          deliver(
            ThreadId.make(recipient),
            delivery,
            "host-pressure:" +
              key +
              ":" +
              decision.kind +
              ":" +
              pressure.level +
              ":" +
              pressure.since +
              ":" +
              recipient,
            pressureNudgeText({
              kind: decision.kind!,
              host,
              pressure,
              consumers: routed.consumers,
              recipient,
              alternatives,
            }),
          ),
        { discard: true },
      );
    }
  }).pipe(Effect.withSpan("PressureNudger.tick"));

  return PressureNudger.of({
    observe,
    admit,
    rank: Effect.fn("PressureNudger.rank")(function* (
      hosts: ReadonlyArray<HostStatusEntry>,
      requirements: HostPlacementRequirements,
    ) {
      const resolved = yield* settings;
      return rankHosts(hosts, requirements, resolved, yield* Clock.currentTimeMillis);
    }),
    tick,
  });
});

export const layer = Layer.effect(
  PressureNudger,
  Effect.gen(function* () {
    const nudger = yield* make;
    yield* Effect.sleep(PRESSURE_NUDGE_INTERVAL_MS).pipe(
      Effect.andThen(nudger.tick),
      Effect.forever,
      Effect.forkScoped,
    );
    return nudger;
  }),
);
