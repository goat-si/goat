import type { HostStatusEntry, HostStatusMetrics, HostStatusQuota } from "@goat/contracts";
import { cpuPercent, diskPercent, memoryPercent } from "@goat/client-runtime/state/host-metrics";

import { formatBytes } from "~/lib/formatBytes";
import { formatElapsedDurationLabel } from "~/timestampFormat";
import { hostComputerUseText } from "./CuaSetupDialog.logic";

export const NOT_AVAILABLE = "Not available";

/** One bar: share in use from 0 to 100, or null when the host did not report it. */
export interface HostMeterView {
  readonly label: string;
  readonly usedPercent: number | null;
  readonly detail: string;
}

export interface HostCardView {
  readonly key: string;
  /** The machine that answered, as opposed to an SSH host it reached. */
  readonly local: boolean;
  readonly label: string;
  readonly platform: string | null;
  /** `GOAT <version>`, or null when the host does not report one. */
  readonly version: string | null;
  readonly tone: "ok" | "stale" | "unavailable";
  /**
   * `Reachable`, `Incompatible`, `Compatibility unknown`, `Last known 4m ago`, `Unreachable`,
   * or `Update GOAT to report status`.
   */
  readonly status: string;
  readonly message: string | null;
  /** Null when the host sent no sample at all: unsupported, or unreachable before its first answer. */
  readonly meters: ReadonlyArray<HostMeterView> | null;
  readonly loadAverage: string | null;
  readonly threads: HostStatusMetrics["threads"] | null;
  readonly quotas: ReadonlyArray<HostStatusQuota>;
  /** Null when the host predates reporting computer use. */
  readonly computerUse: string | null;
}

const PLATFORM_LABELS: Readonly<Record<string, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
  freebsd: "FreeBSD",
  openbsd: "OpenBSD",
};

export function platformLabel(platform: string | undefined): string | null {
  if (platform === undefined) return null;
  return PLATFORM_LABELS[platform] ?? platform;
}

export function hostMeters(metrics: HostStatusMetrics): ReadonlyArray<HostMeterView> {
  const cpu = cpuPercent(metrics);
  const cores = `${metrics.cpuCount} ${metrics.cpuCount === 1 ? "core" : "cores"}`;
  const memory = memoryPercent(metrics);
  const disk = diskPercent(metrics);
  return [
    {
      label: "CPU",
      usedPercent: cpu,
      detail: cpu === null ? cores : `${cpu}% of ${cores}`,
    },
    {
      label: "Memory",
      usedPercent: memory,
      detail:
        memory === null
          ? NOT_AVAILABLE
          : `${formatBytes(metrics.availableMemoryBytes)} free of ${formatBytes(metrics.totalMemoryBytes)}`,
    },
    {
      label: "Disk",
      usedPercent: disk,
      detail:
        metrics.disk === null || disk === null
          ? NOT_AVAILABLE
          : `${formatBytes(metrics.disk.availableBytes)} free of ${formatBytes(metrics.disk.totalBytes)}`,
    },
  ];
}

/** `1.20 · 0.90 · 0.70` for 1, 5, and 15 minutes. Null where the OS has none (Windows). */
export function formatLoadAverage(loadAvg: HostStatusMetrics["loadAvg"]): string | null {
  if (loadAvg === null) return null;
  return [loadAvg.oneMinute, loadAvg.fiveMinutes, loadAvg.fifteenMinutes]
    .map((value) => value.toFixed(2))
    .join(" · ");
}

function statusOf(entry: HostStatusEntry, now: number): Pick<HostCardView, "tone" | "status"> {
  if (entry.reachability === "unsupported") {
    return { tone: "unavailable", status: "Update GOAT to report status" };
  }
  if (entry.reachability === "ok") {
    // A different version alone is fine; only the protocol verdict warns.
    if (entry.compatibility === "incompatible")
      return { tone: "unavailable", status: "Incompatible" };
    if (entry.compatibility === "degraded")
      return { tone: "stale", status: "Compatibility unknown" };
    return { tone: "ok", status: "Reachable" };
  }
  if (entry.lastKnown === true && entry.metrics !== undefined) {
    const age = formatElapsedDurationLabel(new Date(entry.metrics.sampledAt).toISOString(), now);
    return {
      tone: "stale",
      status: age === "just now" ? "Last known just now" : `Last known ${age} ago`,
    };
  }
  return { tone: "unavailable", status: "Unreachable" };
}

/** One card per host, this machine first, in the order the server listed them. */
export function hostCards(
  hosts: ReadonlyArray<HostStatusEntry>,
  now: number,
  localLabel: string,
): ReadonlyArray<HostCardView> {
  return hosts.map((entry) => {
    const metrics = entry.metrics;
    return {
      key: entry.host ?? "\u0000local",
      local: entry.host === null,
      label: entry.host ?? localLabel,
      platform: platformLabel(metrics?.platform),
      version: entry.serverVersion === undefined ? null : `GOAT ${entry.serverVersion}`,
      ...statusOf(entry, now),
      message:
        entry.reachability !== "ok" ||
        entry.compatibility === "incompatible" ||
        entry.compatibility === "degraded"
          ? (entry.message ?? null)
          : null,
      meters: metrics === undefined ? null : hostMeters(metrics),
      loadAverage: metrics === undefined ? null : formatLoadAverage(metrics.loadAvg),
      threads: metrics?.threads ?? null,
      quotas: metrics?.quotas ?? [],
      computerUse: hostComputerUseText(metrics?.computerUse),
    };
  });
}
