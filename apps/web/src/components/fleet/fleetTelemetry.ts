import type { FleetMachine } from "@goat/client-runtime/state/fleet";
import type { EnvironmentThreadShell } from "@goat/client-runtime/state/models";
import {
  FLEET_HEAT_LABEL,
  FLEET_HEAT_THRESHOLDS,
  fleetMachineHeat,
  matchFleetHostEntries,
  type FleetHeatTier,
  type FleetMachineHeat,
} from "@goat/client-runtime/state/fleet-heat";
import { cpuPercent, loadPerCore } from "@goat/client-runtime/state/host-metrics";
import type { EnvironmentId, HostStatusEntry, HostStatusQuota } from "@goat/contracts";

import { formatElapsedDurationLabel } from "~/timestampFormat";

import type { FleetConnection } from "./fleetConnection";

/** What one environment answered about itself and the SSH hosts it reaches. */
export interface FleetHostRead {
  readonly environmentId: EnvironmentId;
  readonly hosts: ReadonlyArray<HostStatusEntry>;
}

/** Ten minutes of 15 s samples. */
const HOST_HISTORY_CAPACITY = 40;
/** Samples older than this are dropped, so a host that went quiet stops drawing an old line. */
const HOST_HISTORY_MAX_AGE_MS = 10 * 60_000;

export function pushBounded<T>(
  list: ReadonlyArray<T>,
  item: T,
  capacity: number,
): ReadonlyArray<T> {
  if (capacity <= 0) return [];
  return [...list.slice(Math.max(0, list.length + 1 - capacity)), item];
}

/**
 * Percentages from 0 to 100; load is the one-minute average. Null where the host sent none.
 * `at` is the host's own clock and only tells samples apart; `seenAt` is this client's clock,
 * so retention and ages hold when a host's clock is off.
 */
export interface HostSample {
  readonly at: number;
  readonly seenAt: number;
  readonly cpu: number | null;
  readonly memory: number | null;
  readonly load: number | null;
}

export type HostHistory = ReadonlyMap<string, ReadonlyArray<HostSample>>;

export const hostSourceKey = (environmentId: EnvironmentId, host: string | null) =>
  environmentId + "\u0000" + (host ?? "");

const percent = (value: number) => Math.min(100, Math.max(0, value * 100));

function sampleOf(metrics: NonNullable<HostStatusEntry["metrics"]>, seenAt: number): HostSample {
  return {
    at: metrics.sampledAt,
    seenAt,
    cpu: metrics.cpuUtilization === null ? null : percent(metrics.cpuUtilization),
    memory:
      metrics.totalMemoryBytes > 0
        ? percent(1 - metrics.availableMemoryBytes / metrics.totalMemoryBytes)
        : null,
    load: metrics.loadAvg?.oneMinute ?? null,
  };
}

/**
 * Appends each reachable host's newest sample. A repeated `sampledAt` (a cached read) adds
 * nothing, so recording the same reads twice is a no-op and returns the same map. Last-known
 * metrics of an unreachable host are not new readings and are not recorded.
 */
export function recordHostSamples(
  history: HostHistory,
  reads: ReadonlyArray<FleetHostRead>,
  now: number,
  capacity = HOST_HISTORY_CAPACITY,
): HostHistory {
  let next: Map<string, ReadonlyArray<HostSample>> | null = null;
  const cutoff = now - HOST_HISTORY_MAX_AGE_MS;
  for (const [key, samples] of history) {
    if (samples.length > 0 && samples[0]!.seenAt >= cutoff) continue;
    const kept = samples.filter((sample) => sample.seenAt >= cutoff);
    next ??= new Map(history);
    if (kept.length === 0) next.delete(key);
    else next.set(key, kept);
  }
  for (const read of reads) {
    for (const entry of read.hosts) {
      if (entry.reachability !== "ok" || entry.metrics === undefined) continue;
      const key = hostSourceKey(read.environmentId, entry.host);
      const samples = (next ?? history).get(key) ?? [];
      if (samples.some((sample) => sample.at === entry.metrics!.sampledAt)) continue;
      next ??= new Map(history);
      next.set(key, pushBounded(samples, sampleOf(entry.metrics, now), capacity));
    }
  }
  return next ?? history;
}

/** When this client last received a new reading from each host, kept after its sparkline expires. */
export type HostLastSeen = ReadonlyMap<string, { readonly at: number; readonly seenAt: number }>;

/** Like the history, a repeated sample changes nothing and returns the same map. */
export function recordLastSeen(
  lastSeen: HostLastSeen,
  reads: ReadonlyArray<FleetHostRead>,
  now: number,
): HostLastSeen {
  let next: Map<string, { readonly at: number; readonly seenAt: number }> | null = null;
  for (const read of reads) {
    for (const entry of read.hosts) {
      if (entry.reachability !== "ok" || entry.metrics === undefined) continue;
      const key = hostSourceKey(read.environmentId, entry.host);
      if ((next ?? lastSeen).get(key)?.at === entry.metrics.sampledAt) continue;
      next ??= new Map(lastSeen);
      next.set(key, { at: entry.metrics.sampledAt, seenAt: now });
    }
  }
  return next ?? lastSeen;
}

/**
 * "last known 4m ago" for a host that stopped answering, timed from when this client last saw
 * it answer. The host's own sample time is used only for a host this client never saw answer.
 */
export function lastKnownLabel(
  row: FleetHostRow,
  lastSeen: HostLastSeen,
  now: number,
): string | null {
  const sampledAt = row.entry?.metrics?.sampledAt;
  if (row.tone !== "stale" || sampledAt === undefined) return null;
  const seenAt =
    (row.sourceKey === null ? undefined : lastSeen.get(row.sourceKey)?.seenAt) ?? sampledAt;
  const age = formatElapsedDurationLabel(new Date(Math.min(seenAt, now)).toISOString(), now);
  return age === "just now" ? "last known just now" : "last known " + age + " ago";
}

export type FleetHostTone = "ok" | "stale" | "unreachable" | "unsupported" | "none";

export interface FleetHostRow {
  readonly key: string;
  readonly label: string;
  /** Null for a host a read reported that is not a Fleet machine. */
  readonly machineId: string | null;
  /** Where its metrics came from; null when no read describes it. */
  readonly sourceKey: string | null;
  readonly entry: HostStatusEntry | null;
  readonly tone: FleetHostTone;
}

function toneOf(entry: HostStatusEntry | null): FleetHostTone {
  if (entry === null) return "none";
  if (entry.reachability === "ok") return "ok";
  if (entry.reachability === "unsupported") return "unsupported";
  return entry.lastKnown === true && entry.metrics !== undefined ? "stale" : "unreachable";
}

/**
 * One row per Fleet machine, matched by the same rule as the graph's heat
 * (matchFleetHostEntries), so a row and its node never describe different hosts.
 * Hosts a read reported that no machine claims follow under their alias, except the
 * primary's entries for this client's own SSH aliases, which are machines already listed.
 */
export function fleetHostRows(input: {
  readonly machines: ReadonlyArray<FleetMachine>;
  readonly sshAliases: ReadonlyMap<EnvironmentId, ReadonlyArray<string>>;
  readonly reports: ReadonlyMap<EnvironmentId, ReadonlyArray<HostStatusEntry>>;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): ReadonlyArray<FleetHostRow> {
  const matched = matchFleetHostEntries(input);
  const sourceOf = new Map<HostStatusEntry, string>();
  for (const [environmentId, hosts] of input.reports) {
    for (const entry of hosts) sourceOf.set(entry, hostSourceKey(environmentId, entry.host));
  }
  const claimed = new Set<string>();
  const rows: FleetHostRow[] = input.machines.map((machine) => {
    const entry = matched.get(machine.id) ?? null;
    const sourceKey = entry === null ? null : (sourceOf.get(entry) ?? null);
    if (sourceKey !== null) claimed.add(sourceKey);
    return {
      key: machine.id,
      label: machine.label,
      machineId: machine.id,
      sourceKey,
      entry,
      tone: toneOf(entry),
    };
  });
  const ownAliases = new Set([...input.sshAliases.values()].flat());
  for (const [environmentId, hosts] of input.reports) {
    for (const entry of hosts) {
      if (entry.host === null) continue;
      const key = hostSourceKey(environmentId, entry.host);
      if (claimed.has(key)) continue;
      if (environmentId === input.primaryEnvironmentId && ownAliases.has(entry.host)) continue;
      claimed.add(key);
      rows.push({
        key,
        label: entry.host,
        machineId: null,
        sourceKey: key,
        entry,
        tone: toneOf(entry),
      });
    }
  }
  return rows;
}

/**
 * A reading's tier on the graph's thresholds. Without the graph's hysteresis: a value is
 * colored by what it is now, while the node's ring holds its tier through small dips.
 */
export function signalTier(
  key: keyof typeof FLEET_HEAT_THRESHOLDS,
  value: number | null,
): FleetHeatTier {
  if (value === null) return "normal";
  const threshold = FLEET_HEAT_THRESHOLDS[key];
  if (value >= threshold.burning) return "burning";
  if (value >= threshold.hot) return "hot";
  return value >= threshold.warm ? "warm" : "normal";
}

const TIER_RANK: Record<FleetHeatTier, number> = { normal: 0, warm: 1, hot: 2, burning: 3 };

export interface HottestHost {
  readonly row: FleetHostRow;
  /** The machine's tier as the graph shows it, or the reading's own for a host with no node. */
  readonly tier: FleetHeatTier;
  readonly cpu: number | null;
  readonly loadPerCore: number | null;
}

/** The hottest host's headline reading: CPU, else load per core, else the tier memory or quota set. */
export function hottestReading(hottest: HottestHost): string {
  if (hottest.cpu !== null) return hottest.cpu + "%";
  if (hottest.loadPerCore !== null) return hottest.loadPerCore.toFixed(1) + "/core";
  return FLEET_HEAT_LABEL[hottest.tier];
}

/** The reachable host working hardest: highest heat tier, then CPU, then load per core. */
export function hottestHost(
  rows: ReadonlyArray<FleetHostRow>,
  heat: ReadonlyMap<string, FleetMachineHeat>,
): HottestHost | null {
  let best: { host: HottestHost; score: readonly [number, number] } | null = null;
  for (const row of rows) {
    const metrics = row.entry?.metrics;
    if (row.tone !== "ok" || metrics === undefined) continue;
    const cpu = cpuPercent(metrics);
    const perCore = loadPerCore(metrics);
    const tier =
      (row.machineId === null ? undefined : heat.get(row.machineId)?.tier) ??
      fleetMachineHeat(row.entry!).tier;
    const score = [
      TIER_RANK[tier],
      cpu ?? (perCore === null ? -1 : Math.min(100, perCore * 100)),
    ] as const;
    if (
      best === null ||
      score[0] > best.score[0] ||
      (score[0] === best.score[0] && score[1] > best.score[1])
    ) {
      best = { host: { row, tier, cpu, loadPerCore: perCore }, score };
    }
  }
  return best?.host ?? null;
}

export type FleetAlertTone = "destructive" | "warning" | "muted";

export interface FleetAlert {
  readonly key: string;
  readonly tone: FleetAlertTone;
  readonly label: string;
  readonly detail: string;
}

const ALERT_ORDER: Record<FleetAlertTone, number> = { destructive: 0, warning: 1, muted: 2 };

function connectionAlert(connection: FleetConnection): Pick<FleetAlert, "tone" | "detail"> | null {
  const detail = connection.reason === null ? connection.label : connection.reason;
  switch (connection.state) {
    case "attention":
      return { tone: "destructive", detail };
    case "connecting":
    case "reconnecting":
    case "degraded":
      return { tone: "warning", detail };
    case "unreachable":
    case "offline":
    case "stopped":
      return { tone: "muted", detail: connection.label };
    default:
      return null;
  }
}

/**
 * Connections that are not up, hosts that stopped answering or cannot report, and hosts on a
 * different GOAT version. A machine whose connection is down already says so, so its
 * unreachable host status is not repeated.
 */
export function fleetAlerts(
  rows: ReadonlyArray<FleetHostRow>,
  connections: ReadonlyMap<string, FleetConnection>,
  now: number,
  options: {
    /** Environments whose last host-status read failed. */
    readonly unreadable?: ReadonlyArray<{ readonly key: string; readonly label: string }>;
    readonly lastSeen?: HostLastSeen;
  } = {},
): ReadonlyArray<FleetAlert> {
  const unreadable = options.unreadable ?? [];
  const lastSeen = options.lastSeen ?? new Map();
  const alerts: FleetAlert[] = unreadable.map(({ key, label }) => ({
    key: key + ":unreadable",
    tone: "warning",
    label,
    detail: "Could not read host status",
  }));
  for (const row of rows) {
    const connection = row.machineId === null ? undefined : connections.get(row.machineId);
    const fromConnection = connection === undefined ? null : connectionAlert(connection);
    if (fromConnection !== null) {
      alerts.push({ key: row.key + ":connection", label: row.label, ...fromConnection });
    }
    const entry = row.entry;
    if (entry === null) continue;
    if (fromConnection === null && (row.tone === "stale" || row.tone === "unreachable")) {
      const lastKnown = lastKnownLabel(row, lastSeen, now);
      alerts.push({
        key: row.key + ":reach",
        tone: "warning",
        label: row.label,
        detail: lastKnown === null ? "Unreachable" : "Unreachable, " + lastKnown,
      });
    }
    if (row.tone === "unsupported") {
      alerts.push({
        key: row.key + ":unsupported",
        tone: "muted",
        label: row.label,
        detail: "Update GOAT to report status",
      });
    }
    // As in Settings > Hosts, only the protocol verdict warns; builds of different versions
    // work together. versionMismatch decides only when the fan-out machine predates verdicts.
    const version = entry.serverVersion === undefined ? "" : ", runs GOAT " + entry.serverVersion;
    if (row.tone === "ok" && entry.compatibility === "incompatible") {
      alerts.push({
        key: row.key + ":version",
        tone: "destructive",
        label: row.label,
        detail: "Incompatible" + version,
      });
    } else if (row.tone === "ok" && entry.compatibility === "degraded") {
      alerts.push({
        key: row.key + ":version",
        tone: "muted",
        label: row.label,
        detail: "Compatibility unknown" + version,
      });
    } else if (entry.compatibility === undefined && entry.versionMismatch === true) {
      alerts.push({
        key: row.key + ":version",
        tone: "warning",
        label: row.label,
        detail:
          entry.serverVersion === undefined
            ? "Different GOAT version"
            : "Runs GOAT " + entry.serverVersion,
      });
    }
  }
  return alerts.toSorted((left, right) => ALERT_ORDER[left.tone] - ALERT_ORDER[right.tone]);
}

export type ThroughputShell = Pick<
  EnvironmentThreadShell,
  "environmentId" | "archivedAt" | "deletedAt" | "sideChatOf" | "lineage" | "latestRun"
>;

export interface FleetThroughput {
  readonly started: number;
  readonly finished: number;
  /** Oldest bucket first. */
  readonly startedBuckets: ReadonlyArray<number>;
  readonly finishedBuckets: ReadonlyArray<number>;
}

const THROUGHPUT_WINDOW_MS = 60 * 60_000;
export const THROUGHPUT_BUCKETS = 12;

interface RunTimes {
  readonly started: number | null;
  readonly finished: number | null;
}

/*
 * Shell objects are replaced only when that thread changes, so each one is classified and its
 * timestamps parsed once. A streamed update to one thread then costs one parse, not one per
 * thread.
 */
const runTimesByShell = new WeakMap<ThroughputShell, RunTimes | null>();

function runTimesOf(shell: ThroughputShell): RunTimes | null {
  const cached = runTimesByShell.get(shell);
  if (cached !== undefined) return cached;
  const run = shell.latestRun;
  const times =
    run === null ||
    shell.archivedAt !== null ||
    shell.deletedAt !== null ||
    shell.sideChatOf != null ||
    shell.lineage.relationshipToParent === "subagent"
      ? null
      : {
          started: run.startedAt === null ? null : Date.parse(run.startedAt),
          finished: run.completedAt === null ? null : Date.parse(run.completedAt),
        };
  runTimesByShell.set(shell, times);
  return times;
}

/**
 * Runs started and finished in the last hour across connected environments, counted from each
 * thread's latest run, so a thread that ran twice in the hour counts once. Top-level threads
 * only, as the Fleet counts them.
 */
export function fleetThroughput(
  shells: ReadonlyArray<ThroughputShell>,
  connected: ReadonlySet<EnvironmentId>,
  now: number,
  windowMs = THROUGHPUT_WINDOW_MS,
  buckets = THROUGHPUT_BUCKETS,
): FleetThroughput {
  const from = now - windowMs;
  const bucketMs = windowMs / buckets;
  const startedBuckets: number[] = Array.from({ length: buckets }, () => 0);
  const finishedBuckets: number[] = Array.from({ length: buckets }, () => 0);
  const place = (at: number | null, into: number[]) => {
    if (at === null || !(at >= from && at <= now)) return false;
    into[Math.min(buckets - 1, Math.floor((at - from) / bucketMs))]! += 1;
    return true;
  };
  let started = 0;
  let finished = 0;
  for (const shell of shells) {
    const times = runTimesOf(shell);
    if (times === null || !connected.has(shell.environmentId)) continue;
    if (place(times.started, startedBuckets)) started += 1;
    if (place(times.finished, finishedBuckets)) finished += 1;
  }
  return { started, finished, startedBuckets, finishedBuckets };
}

export function throughputEqual(left: FleetThroughput, right: FleetThroughput): boolean {
  return (
    left.started === right.started &&
    left.finished === right.finished &&
    left.startedBuckets.every((count, index) => count === right.startedBuckets[index]) &&
    left.finishedBuckets.every((count, index) => count === right.finishedBuckets[index])
  );
}

export interface FleetQuotaRow {
  readonly key: string;
  readonly label: string;
  /** The host it was read on, when accounts could not be told apart. */
  readonly host: string | null;
  readonly driver: HostStatusQuota["driver"];
  readonly windows: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly usedPercent: number;
  }>;
  readonly peak: number;
}

/**
 * Provider quota per account. Accounts are merged across hosts only by the credential
 * fingerprint the provider reports, keeping the latest check; without one, each host's
 * instance stays its own row, since the same instance id on two machines can be two accounts.
 */
export function quotaRows(
  rows: ReadonlyArray<FleetHostRow>,
  maxWindows = 2,
): ReadonlyArray<FleetQuotaRow> {
  const byAccount = new Map<string, { quota: HostStatusQuota; host: string | null }>();
  for (const row of rows) {
    for (const quota of row.entry?.metrics?.quotas ?? []) {
      if (quota.limits.unavailable !== undefined || quota.limits.windows.length === 0) continue;
      const fingerprint = quota.limits.credentialFingerprint;
      const key =
        fingerprint === undefined
          ? JSON.stringify([row.key, quota.instanceId])
          : JSON.stringify([quota.driver, fingerprint]);
      const existing = byAccount.get(key);
      if (existing === undefined || existing.quota.limits.checkedAt < quota.limits.checkedAt) {
        byAccount.set(key, { quota, host: fingerprint === undefined ? row.label : null });
      }
    }
  }
  return [...byAccount]
    .map(([key, { quota, host }]): FleetQuotaRow => {
      const windows = quota.limits.windows
        .toSorted((left, right) => right.usedPercent - left.usedPercent)
        .slice(0, maxWindows)
        .map(({ id, label, usedPercent }) => ({ id, label, usedPercent }));
      return {
        key,
        label: quota.displayName ?? quota.instanceId,
        host,
        driver: quota.driver,
        windows,
        peak: windows[0]?.usedPercent ?? 0,
      };
    })
    .toSorted((left, right) => right.peak - left.peak);
}

/**
 * One SVG path for a series in a width x height box, values from 0 to `max`. Gaps (null) break
 * the line; a single value draws a short level stroke so it still reads as a reading.
 */
export function sparklinePath(
  values: ReadonlyArray<number | null>,
  width: number,
  height: number,
  max: number,
  slots = HOST_HISTORY_CAPACITY,
): string {
  if (values.length === 0 || max <= 0) return "";
  const step = width / Math.max(1, slots - 1);
  const offset = width - step * (values.length - 1);
  const y = (value: number) =>
    +(height - (Math.min(max, Math.max(0, value)) / max) * height).toFixed(2);
  let path = "";
  let open = false;
  values.forEach((value, index) => {
    if (value === null) {
      open = false;
      return;
    }
    const x = +(offset + step * index).toFixed(2);
    path += (open ? "L" : "M") + x + " " + y(value);
    open = true;
  });
  if (values.length === 1 && values[0] !== null) {
    const level = y(values[0]!);
    return "M" + +(width - step).toFixed(2) + " " + level + "L" + width + " " + level;
  }
  return path;
}
