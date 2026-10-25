import type { GoatHostStatusResult, HostCondition, HostStatusEntry } from "@goat/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as HostPowerMonitor from "../../background/HostPowerMonitor.ts";
import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as HostStatusMcpService from "../../mcp/HostStatusMcpService.ts";
import * as LaunchWatchService from "../../mcp/LaunchWatchService.ts";
import type { McpInvocationScope } from "../../mcp/McpInvocationContext.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as FleetHostStates from "./FleetHostStates.ts";
import {
  deriveConditions,
  emptyContact,
  forgetFailures,
  HOST_HEALTH_THRESHOLDS,
  initialClock,
  observeTick,
  recordAnswer,
  recordFailure,
  recordOutage,
  recordSample,
  type HostContact,
  type HostHealthThresholds,
  type MonitorClock,
} from "./hostHealthModel.ts";

/** Launch watches scanned for outages when conditions are read. */
const OUTAGE_SCAN_LIMIT = 200;

export interface HostConditionSet {
  readonly host: string | null;
  readonly conditions: ReadonlyArray<HostCondition>;
  readonly observedAt: string;
}

export interface HostHealthMonitorShape {
  /** Records each goat_host_status entry and adds this machine's conditions to it. */
  readonly annotate: (result: GoatHostStatusResult) => Effect.Effect<GoatHostStatusResult>;
  /** A thread status read or other call reached the host, or failed to. */
  readonly recordContact: (host: string, error: string | null) => Effect.Effect<void>;
  /** Conditions now; an Unknown host is probed first, at most once a minute. */
  readonly conditions: (host: string | null) => Effect.Effect<HostConditionSet>;
  /** Hosts this machine has heard from, with their last goat_host_status sample. */
  readonly known: Effect.Effect<
    ReadonlyArray<{ readonly host: string; readonly sample: HostStatusEntry | null }>
  >;
  /** Notices this machine's sleep. No I/O; runs on every Scheduler tick. */
  readonly tick: Effect.Effect<void>;
}

/** Host signals behind Health; also serves goat_host_status and the cordon tools. */
export class HostHealthMonitor extends Context.Service<HostHealthMonitor, HostHealthMonitorShape>()(
  "goat/fleet/health/HostHealthMonitor",
) {}

const keyOf = (host: string | null) => host ?? FleetHostStates.LOCAL_HOST;

export const make = (
  options: {
    readonly thresholds?: HostHealthThresholds;
    /** One goat_host_status read of a host; the live layer reads it over SSH, read-only. */
    readonly probe?: (host: string) => Effect.Effect<HostStatusEntry>;
  } = {},
) =>
  Effect.gen(function* () {
    const thresholds = options.thresholds ?? HOST_HEALTH_THRESHOLDS;
    const states = yield* FleetHostStates.FleetHostStates;
    const power = yield* Effect.serviceOption(HostPowerMonitor.HostPowerMonitor);
    const watches = yield* Effect.serviceOption(LaunchWatchService.LaunchWatchService);
    const contacts = yield* Ref.make(new Map<string, HostContact>());
    const clock = yield* Ref.make<MonitorClock>(initialClock);
    const lastProbe = new Map<string, number>();
    // This machine's own goat_host_status answer, for its quota conditions.
    const localSample = yield* Ref.make<HostStatusEntry | null>(null);

    /** Suspend and resume both start a fresh grace window and drop failures counted so far. */
    const markWake = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      yield* Ref.set(clock, {
        lastTickAt: now,
        quietUntil: now + thresholds.wakeGraceMs,
        wokeAt: now,
      });
      yield* Ref.update(
        contacts,
        (all) => new Map([...all].map(([host, contact]) => [host, forgetFailures(contact)])),
      );
    });
    if (power._tag === "Some") {
      // A sleep shorter than the tick gap leaves no gap to notice; the power monitor says so.
      let suspended = (yield* power.value.snapshot).suspended;
      yield* power.value.streamChanges.pipe(
        Stream.runForEach((snapshot) => {
          const changed = snapshot.suspended !== suspended;
          suspended = snapshot.suspended;
          return changed ? markWake : Effect.void;
        }),
        Effect.forkScoped,
      );
    }

    const update = (
      host: string,
      change: (contact: HostContact, now: number, clock: MonitorClock) => HostContact,
    ) =>
      Effect.gen(function* () {
        // Notice a wake before using contacts: a call can arrive before the clock source ticks.
        yield* tick;
        const now = yield* Clock.currentTimeMillis;
        const current = yield* Ref.get(clock);
        yield* Ref.update(contacts, (all) =>
          new Map(all).set(host, change(all.get(host) ?? emptyContact, now, current)),
        );
      });

    const mergeOutages = Effect.gen(function* () {
      if (watches._tag === "None") return;
      const remote = yield* watches.value
        .listRemote(OUTAGE_SCAN_LIMIT)
        .pipe(Effect.orElseSucceed(() => []));
      for (const watch of remote) {
        const outage = watch.outage;
        if (watch.host === null || outage === null) continue;
        yield* update(watch.host, (contact, now, current) =>
          recordOutage(contact, outage, now, current, thresholds),
        );
      }
    });

    const derive = (host: string | null) =>
      Effect.gen(function* () {
        yield* tick;
        const now = yield* Clock.currentTimeMillis;
        const state = yield* states.get(keyOf(host));
        // This machine always answers itself.
        const contact =
          host === null
            ? recordAnswer(emptyContact, now, (yield* Ref.get(localSample)) ?? undefined)
            : ((yield* Ref.get(contacts)).get(host) ?? emptyContact);
        return {
          host,
          conditions: deriveConditions({ contact, scheduling: state, now, thresholds }),
          observedAt: DateTime.formatIso(DateTime.makeUnsafe(now)),
        } satisfies HostConditionSet;
      });

    const conditions: HostHealthMonitorShape["conditions"] = (host) =>
      Effect.gen(function* () {
        if (host !== null) yield* mergeOutages;
        const first = yield* derive(host);
        const probe = options.probe;
        if (host === null || probe === undefined) return first;
        if (!first.conditions.some((condition) => condition.type === "Unknown")) return first;
        const now = yield* Clock.currentTimeMillis;
        if (now - (lastProbe.get(host) ?? Number.NEGATIVE_INFINITY) < thresholds.probeIntervalMs) {
          return first;
        }
        lastProbe.set(host, now);
        const entry = yield* probe(host);
        yield* update(host, (contact, at, current) => recordSample(contact, entry, at, current));
        return yield* derive(host);
      });

    const annotate: HostHealthMonitorShape["annotate"] = (result) =>
      Effect.gen(function* () {
        yield* mergeOutages;
        for (const entry of result.hosts) {
          if (entry.host === null) {
            if (entry.reachability === "ok") yield* Ref.set(localSample, entry);
            continue;
          }
          const host = entry.host;
          yield* update(host, (contact, now, current) =>
            recordSample(contact, entry, now, current),
          );
        }
        const hosts = yield* Effect.forEach(result.hosts, (entry) =>
          derive(entry.host).pipe(
            Effect.map((set) => ({ ...entry, conditions: [...set.conditions] })),
          ),
        );
        return { ...result, hosts };
      });

    const tick = Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const suspended = power._tag === "Some" ? (yield* power.value.snapshot).suspended : false;
      const observed = observeTick(yield* Ref.get(clock), now, suspended, thresholds);
      yield* Ref.set(clock, observed.clock);
      if (observed.woke) {
        yield* Ref.update(
          contacts,
          (all) => new Map([...all].map(([host, contact]) => [host, forgetFailures(contact)])),
        );
      }
    });

    return HostHealthMonitor.of({
      annotate,
      recordContact: (host, error) =>
        update(host, (contact, now, current) =>
          error === null
            ? recordAnswer(contact, now)
            : recordFailure(contact, now, error, current, thresholds),
        ),
      conditions,
      known: Ref.get(contacts).pipe(
        Effect.map((all) => [...all].map(([host, contact]) => ({ host, sample: contact.sample }))),
      ),
      tick,
    });
  });

/** goat_host_status for one host, as a read-only client: no writes, this machine's SSH keys. */
const liveProbe = Effect.gen(function* () {
  const status = yield* HostStatusMcpService.HostStatusMcpService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  return (host: string) =>
    Clock.currentTimeMillis.pipe(
      Effect.flatMap((issuedAt) => {
        const scope: McpInvocationScope = {
          environmentId: descriptor.environmentId,
          capabilities: new Set(["orchestration"]),
          issuedAt,
          requestNamespace: "fleet-health",
          thread: undefined,
          client: { sessionId: "fleet-health", label: "GOAT fleet health", access: "read-only" },
        };
        return status.read(scope, { host });
      }),
      Effect.map(
        (result): HostStatusEntry =>
          result.hosts[0] ?? { host, reachability: "unreachable", message: "No answer." },
      ),
      Effect.catch((error) =>
        Effect.succeed<HostStatusEntry>({
          host,
          reachability: "unreachable",
          message: error.message,
        }),
      ),
    );
});

export const layer = Layer.effect(
  HostHealthMonitor,
  Effect.gen(function* () {
    const monitor = yield* make({ probe: yield* liveProbe });
    const scheduler = yield* Scheduler.Scheduler;
    // Local bookkeeping only; it probes nothing, so it keeps time while automation is held.
    yield* scheduler.register("fleet-health-clock", monitor.tick, { whileAutomationHeld: "run" });
    return monitor;
  }),
);
