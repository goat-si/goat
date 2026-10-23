import {
  CommandId,
  MessageId,
  ThreadId,
  type GoatHostStatusResult,
  type HostPlacementRanking,
  type HostPlacementRequirements,
  type HostPressure,
  type HostPressureAdvice,
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
  HOST_PRESSURE_KEY_PREFIX,
  launchAdvice,
  NOTHING_ANNOUNCED,
  nudgeDecision,
  pressureHostKey,
  pressureNudgeText,
  pressureRecipients,
  pressureStatusText,
  rankHosts,
  resolvePressureSettings,
  roomyHosts,
  sampleFromEntry,
  stepPressure,
  toHostPressure,
  type AnnouncedPressure,
  type PressureState,
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

/** A legacy host's entry with the level stepped here, so a spike in one reading never ranks it. */
const withSustained = (reading: RemoteReading): HostStatusEntry =>
  reading.entry.pressure === undefined && reading.state !== null
    ? { ...reading.entry, pressure: toHostPressure(reading.state) }
    : reading.entry;

/** Shared cached admission state; construction does not depend on watches or host-status reads. */
export class PressureAdmissionService extends Context.Service<
  PressureAdmissionService,
  {
    readonly observe: PressureNudgerShape["observe"];
    readonly admit: PressureNudgerShape["admit"];
    readonly pressureOf: (host: string | null) => Effect.Effect<HostPressure | undefined>;
    readonly freshEntries: Effect.Effect<ReadonlyArray<HostStatusEntry>>;
    /** The same entries with each legacy host's sustained level from readings held here. */
    readonly sustained: (
      entries: ReadonlyArray<HostStatusEntry>,
    ) => Effect.Effect<ReadonlyArray<HostStatusEntry>>;
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
    return withSustained(reading).pressure;
  });

  const freshEntries = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    return [...(yield* Ref.get(readings)).values()]
      .filter((reading) => now - reading.at <= PRESSURE_READING_MAX_AGE_MS)
      .map(withSustained);
  });

  const sustained = Effect.fn("PressureNudger.sustained")(function* (
    entries: ReadonlyArray<HostStatusEntry>,
  ) {
    const held = yield* Ref.get(readings);
    return entries.map((entry) => {
      const reading = held.get(pressureHostKey(entry.host));
      return entry.pressure === undefined && reading !== undefined
        ? withSustained({ ...reading, entry })
        : entry;
    });
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

  return PressureAdmissionService.of({ observe, admit, pressureOf, freshEntries, sustained });
});
export const layerAdmission = Layer.effect(PressureAdmissionService, makeAdmission);

export const make = Effect.gen(function* () {
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const { observe, admit, pressureOf, freshEntries, sustained } = yield* PressureAdmissionService;
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

  const quietly = (threadId: ThreadId) =>
    Effect.catchCause((cause) =>
      Effect.logWarning("fleet.pressure.notice-failed", { threadId, cause }),
    );

  /** Writes the host's status row; the same record key rewrites it in place. */
  const writeRow = (input: {
    readonly threadId: ThreadId;
    readonly recordKey: string;
    readonly revision: string;
    readonly message: string;
    readonly critical: boolean;
  }) =>
    threads
      .dispatch({
        type: "thread.notice.record",
        commandId: CommandId.make("server:" + input.recordKey + ":" + input.revision),
        threadId: input.threadId,
        recordKey: input.recordKey,
        message: input.message,
        severity: input.critical ? "warning" : "info",
      })
      .pipe(Effect.asVoid, quietly(input.threadId));

  const wake = (
    threadId: ThreadId,
    key: string,
    message: { readonly text: string; readonly summary: string },
  ) =>
    threads
      .dispatch({
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
      .pipe(Effect.asVoid, quietly(threadId));

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
      const { next, nudge } = nudgeDecision(before, pressure.level, now, resolved);
      const hold = (value: AnnouncedPressure) =>
        Ref.update(announced, (current) => new Map(current).set(key, value));
      if (nudge === null) {
        yield* hold(next);
        continue;
      }
      shells ??= yield* threads
        .listProjectThreads({ projectId: undefined, includeSubagents: true })
        .pipe(Effect.orElseSucceed(() => []));
      const routed = pressureRecipients({
        host,
        environmentId: descriptor.environmentId,
        shells,
        watches: active,
      });
      // A row keeps reaching the threads that hold it, so recovery reaches them after work ends.
      const rowRecipients =
        nudge.row === null
          ? []
          : [
              ...new Set([
                ...(nudge.row.opened ? [] : (next.row?.recipients ?? [])),
                ...routed.recipients,
              ]),
            ].toSorted();
      yield* hold(
        next.row === null || nudge.row === null
          ? next
          : { ...next, row: { ...next.row, recipients: rowRecipients } },
      );
      const wakeRecipients = nudge.wake ? routed.recipients : [];
      if (rowRecipients.length === 0 && wakeRecipients.length === 0) continue;
      if (nudge.kind !== "recover" && entries === null) entries = (yield* readAll).hosts;
      const alternatives =
        nudge.kind === "recover"
          ? []
          : roomyHosts(
              entries === null ? yield* freshEntries : yield* sustained(entries),
              host,
              resolved,
              now,
            );
      yield* Effect.logInfo("fleet.pressure.notice", {
        host: key,
        level: pressure.level,
        kind: nudge.kind,
        row: nudge.row === null ? null : nudge.row.opened ? "opened" : "updated",
        wake: wakeRecipients.length,
        recipients: rowRecipients.length,
      });
      const text = (recipient: string) => ({
        kind: nudge.kind,
        host,
        pressure,
        consumers: routed.consumers,
        recipient,
        alternatives,
      });
      const rowId = nudge.row?.id;
      if (rowId !== undefined)
        yield* Effect.forEach(
          rowRecipients,
          (recipient) =>
            writeRow({
              threadId: ThreadId.make(recipient),
              recordKey: "host-pressure:" + key + ":" + rowId + ":" + recipient,
              revision: pressure.level + ":" + pressure.since,
              message: pressureStatusText(text(recipient)),
              critical: pressure.level === "critical",
            }),
          { discard: true },
        );
      yield* Effect.forEach(
        wakeRecipients,
        (recipient) =>
          wake(
            ThreadId.make(recipient),
            HOST_PRESSURE_KEY_PREFIX +
              key +
              ":wake:" +
              pressure.level +
              ":" +
              pressure.since +
              ":" +
              recipient,
            pressureNudgeText(text(recipient)),
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
      return rankHosts(
        yield* sustained(hosts),
        requirements,
        resolved,
        yield* Clock.currentTimeMillis,
      );
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
