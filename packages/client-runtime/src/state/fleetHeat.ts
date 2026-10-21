import type { EnvironmentId, HostStatusEntry, HostStatusMetrics } from "@goat/contracts";

import type { FleetMachine } from "./fleet.ts";
import { cpuPercent, loadPerCore, memoryPercent } from "./host-metrics.ts";

/**
 * How hard a Fleet machine is working, from the same host-status sample Settings
 * shows. The graph colors a node by tier and sets the hottest ones alight.
 *
 * A tier is the highest one any signal reaches. Rising takes effect on the next
 * sample; falling waits until the signal drops a margin below the threshold, so
 * a host idling around a boundary does not flicker between two looks every 15s.
 */
export type FleetHeatTier = "normal" | "warm" | "hot" | "burning";

export const FLEET_HEAT_TIERS: ReadonlyArray<FleetHeatTier> = ["normal", "warm", "hot", "burning"];

/** Each signal's warm, hot, and burning thresholds, and how far below one it must fall to leave. */
export const FLEET_HEAT_THRESHOLDS = {
  /** CPU in use, percent. One 200ms sample is noisy, hence the wide margin. */
  cpu: { warm: 60, hot: 80, burning: 92, margin: 8 },
  /** One-minute load average per core. Above 1, work is queueing for a CPU. */
  load: { warm: 0.7, hot: 1, burning: 1.5, margin: 0.15 },
  /** Memory in use, percent, from available memory (not just free pages). */
  memory: { warm: 80, hot: 90, burning: 95, margin: 3 },
  /** The fullest provider quota window, percent. It only falls at a reset. */
  quota: { warm: 70, hot: 85, burning: 95, margin: 2 },
} as const;

type SignalKey = keyof typeof FLEET_HEAT_THRESHOLDS;

export interface FleetHeatSignals {
  readonly cpuPercent: number | null;
  readonly loadPerCore: number | null;
  readonly memoryPercent: number | null;
  /** The fullest quota window across the host's provider accounts. */
  readonly quota: { readonly label: string; readonly usedPercent: number } | null;
}

export function fleetHeatSignals(
  metrics: Pick<
    HostStatusMetrics,
    | "cpuUtilization"
    | "loadAvg"
    | "cpuCount"
    | "availableMemoryBytes"
    | "totalMemoryBytes"
    | "quotas"
  >,
): FleetHeatSignals {
  let quota: FleetHeatSignals["quota"] = null;
  for (const account of metrics.quotas) {
    if (account.limits.unavailable !== undefined) continue;
    for (const window of account.limits.windows) {
      if (quota !== null && window.usedPercent <= quota.usedPercent) continue;
      const name = account.displayName ?? account.driver;
      quota = { label: name + " " + window.label.toLowerCase(), usedPercent: window.usedPercent };
    }
  }
  return {
    cpuPercent: cpuPercent(metrics),
    loadPerCore: loadPerCore(metrics),
    memoryPercent: memoryPercent(metrics),
    quota,
  };
}

const signalValue = (signals: FleetHeatSignals, key: SignalKey): number | null =>
  key === "cpu"
    ? signals.cpuPercent
    : key === "load"
      ? signals.loadPerCore
      : key === "memory"
        ? signals.memoryPercent
        : (signals.quota?.usedPercent ?? null);

/** 0 normal through 3 burning, with every threshold lowered by `slack` margins. */
function signalLevel(signals: FleetHeatSignals, key: SignalKey, slack: number): number {
  const value = signalValue(signals, key);
  if (value === null) return 0;
  const { warm, hot, burning, margin } = FLEET_HEAT_THRESHOLDS[key];
  const shift = margin * slack;
  return value >= burning - shift ? 3 : value >= hot - shift ? 2 : value >= warm - shift ? 1 : 0;
}

const SIGNAL_KEYS = Object.keys(FLEET_HEAT_THRESHOLDS) as ReadonlyArray<SignalKey>;

const levelOf = (signals: FleetHeatSignals, slack: number) =>
  Math.max(...SIGNAL_KEYS.map((key) => signalLevel(signals, key, slack)));

/**
 * The tier for a new sample, given the tier the machine showed before. Going up
 * is immediate; going down holds the previous tier while any signal is still
 * within its margin of that tier's threshold.
 */
export function fleetHeatTier(
  signals: FleetHeatSignals,
  previous: FleetHeatTier = "normal",
): FleetHeatTier {
  const rising = levelOf(signals, 0);
  const before = FLEET_HEAT_TIERS.indexOf(previous);
  if (rising >= before) return FLEET_HEAT_TIERS[rising]!;
  const holding = Math.min(before, levelOf(signals, 1));
  return FLEET_HEAT_TIERS[Math.max(rising, holding)]!;
}

const formatSignal = (signals: FleetHeatSignals, key: SignalKey): string | null => {
  const value = signalValue(signals, key);
  if (value === null) return null;
  if (key === "cpu") return "CPU " + value + "%";
  if (key === "load") return "load " + value.toFixed(1) + "/core";
  if (key === "memory") return "memory " + value + "%";
  return signals.quota!.label + " " + Math.round(value) + "%";
};

/** Why a machine is warm or hotter, hottest signal first. Empty when nothing is. */
export function fleetHeatReasons(signals: FleetHeatSignals): ReadonlyArray<string> {
  return SIGNAL_KEYS.map((key) => ({ key, level: signalLevel(signals, key, 0) }))
    .filter((signal) => signal.level > 0)
    .sort((left, right) => right.level - left.level)
    .flatMap((signal) => formatSignal(signals, signal.key) ?? []);
}

/**
 * `live` is a fresh sample. `stale` repeats the last one from a host that stopped
 * answering, `unavailable` is a host that answered with nothing to show, and
 * `none` is a machine no report covers. Only `live` heats a node.
 */
export type FleetHeatStatus = "live" | "stale" | "unavailable" | "none";

export interface FleetMachineHeat {
  readonly tier: FleetHeatTier;
  readonly status: FleetHeatStatus;
  readonly signals: FleetHeatSignals | null;
  readonly reasons: ReadonlyArray<string>;
  /** One line for a tooltip or label: what the machine is doing, or why there is nothing to show. */
  readonly summary: string;
}

export const FLEET_HEAT_LABEL: Readonly<Record<FleetHeatTier, string>> = {
  normal: "Normal",
  warm: "Warm",
  hot: "Running hot",
  burning: "Burning",
};

export const NO_FLEET_HEAT: FleetMachineHeat = {
  tier: "normal",
  status: "none",
  signals: null,
  reasons: [],
  summary: "No metrics",
};

/**
 * A machine's heat from its host-status entry and the tier it showed last. Heat is
 * load only: a reachable host's sample is live whatever its version or protocol
 * verdict, which Settings' Hosts section reports.
 */
export function fleetMachineHeat(
  entry: HostStatusEntry | undefined,
  previous: FleetHeatTier = "normal",
): FleetMachineHeat {
  if (entry === undefined) return NO_FLEET_HEAT;
  if (entry.reachability !== "ok" || entry.metrics === undefined) {
    const stale = entry.lastKnown === true && entry.metrics !== undefined;
    return {
      tier: "normal",
      status: stale ? "stale" : "unavailable",
      signals: null,
      reasons: [],
      summary: stale ? "Metrics not live: host stopped answering" : "Metrics unavailable",
    };
  }
  const signals = fleetHeatSignals(entry.metrics);
  const tier = fleetHeatTier(signals, previous);
  const reasons = fleetHeatReasons(signals);
  const context = (["cpu", "load", "memory"] as const).flatMap(
    (key) => formatSignal(signals, key) ?? [],
  );
  const summary =
    tier === "normal"
      ? context.join(" · ") || "No metrics"
      : FLEET_HEAT_LABEL[tier] + ": " + (reasons.length > 0 ? reasons : context).join(" · ");
  return { tier, status: "live", signals, reasons, summary };
}

const signalsEqual = (left: FleetHeatSignals | null, right: FleetHeatSignals | null) =>
  left === right ||
  (left !== null &&
    right !== null &&
    left.cpuPercent === right.cpuPercent &&
    left.loadPerCore === right.loadPerCore &&
    left.memoryPercent === right.memoryPercent &&
    left.quota?.label === right.quota?.label &&
    left.quota?.usedPercent === right.quota?.usedPercent);

/** Same tier, status, text, and readings, so a consumer showing any of them can keep the old value. */
export function fleetMachineHeatEqual(left: FleetMachineHeat, right: FleetMachineHeat): boolean {
  return (
    left.tier === right.tier &&
    left.status === right.status &&
    left.summary === right.summary &&
    left.reasons.join("|") === right.reasons.join("|") &&
    signalsEqual(left.signals, right.signals)
  );
}

/**
 * Which host-status entry describes each Fleet machine, or none rather than a guess:
 *
 * 1. An environment's own answer (its `host: null` entry) describes it.
 * 2. Otherwise the primary environment's entry for one of the SSH aliases this
 *    client reaches that environment through.
 * 3. Otherwise the primary's entry whose alias equals the machine's label, when
 *    exactly one entry and one such machine match and no environment claims that alias.
 * 4. An SSH or cloud host a dispatcher reported is that dispatcher's entry for
 *    the same alias.
 */
export function matchFleetHostEntries(input: {
  readonly machines: ReadonlyArray<
    Pick<FleetMachine, "id" | "label" | "environmentId" | "sshHost">
  >;
  readonly sshAliases: ReadonlyMap<EnvironmentId, ReadonlyArray<string>>;
  /** Each environment's own host-status answer, where it has one. */
  readonly reports: ReadonlyMap<EnvironmentId, ReadonlyArray<HostStatusEntry>>;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): ReadonlyMap<string, HostStatusEntry> {
  const matched = new Map<string, HostStatusEntry>();
  const relayed =
    input.primaryEnvironmentId === null
      ? []
      : (input.reports.get(input.primaryEnvironmentId) ?? []).filter(
          (entry) => entry.host !== null,
        );
  const claimed = new Set([...input.sshAliases.values()].flat());
  const labelCount = new Map<string, number>();
  for (const machine of input.machines) {
    if (machine.sshHost !== null || machine.environmentId === null) continue;
    const label = machine.label.toLowerCase();
    labelCount.set(label, (labelCount.get(label) ?? 0) + 1);
  }
  for (const machine of input.machines) {
    if (machine.sshHost !== null) {
      const { via, alias } = machine.sshHost;
      const entry = input.reports.get(via)?.find((candidate) => candidate.host === alias);
      if (entry !== undefined) matched.set(machine.id, entry);
      continue;
    }
    if (machine.environmentId === null) continue;
    const own = input.reports.get(machine.environmentId)?.find((entry) => entry.host === null);
    if (own !== undefined) {
      matched.set(machine.id, own);
      continue;
    }
    const aliases = input.sshAliases.get(machine.environmentId) ?? [];
    const byAlias = relayed.find((entry) => aliases.includes(entry.host!));
    if (byAlias !== undefined) {
      matched.set(machine.id, byAlias);
      continue;
    }
    const label = machine.label.toLowerCase();
    const byLabel = relayed.filter(
      (entry) => entry.host!.toLowerCase() === label && !claimed.has(entry.host!),
    );
    if (byLabel.length === 1 && labelCount.get(label) === 1) matched.set(machine.id, byLabel[0]!);
  }
  return matched;
}

/**
 * Whether Fleet should read an environment's own host status. The primary
 * always is read; it answers for itself and every SSH host it holds open.
 * Another environment is read when that answer does not cover it, or when a
 * machine in the fleet is an SSH or cloud host it dispatched to, whose metrics
 * only its own answer carries. While the primary's answer is on its way, only an
 * environment it cannot cover (no SSH alias) is read, so neither waits on the other.
 */
export function fleetHostStatusNeeded(input: {
  readonly environmentId: EnvironmentId;
  readonly sshAliases: ReadonlyArray<string>;
  readonly primaryEnvironmentId: EnvironmentId | null;
  /** The primary's answer for its SSH hosts; null while it is on its way, empty with no primary. */
  readonly primaryHosts: ReadonlyArray<HostStatusEntry> | null;
  readonly dispatchers: ReadonlySet<EnvironmentId>;
}): boolean {
  if (input.environmentId === input.primaryEnvironmentId) return true;
  if (input.dispatchers.has(input.environmentId)) return true;
  if (input.primaryHosts === null) return input.sshAliases.length === 0;
  return !input.primaryHosts.some(
    (entry) =>
      entry.reachability === "ok" && entry.host !== null && input.sshAliases.includes(entry.host),
  );
}
