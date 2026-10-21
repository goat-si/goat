import type { HostStatusMetrics } from "@goat/contracts";

/**
 * Shares of a host's capacity in use, from 0 to 100, shared by Settings' host
 * cards and the Fleet graph so both read one sample the same way.
 */

const clampPercent = (value: number) => Math.min(100, Math.max(0, Math.round(value)));

/** Used share of a total from what is still free. Null when the total is unknown. */
function usedPercent(availableBytes: number, totalBytes: number): number | null {
  if (!(totalBytes > 0)) return null;
  return clampPercent((1 - availableBytes / totalBytes) * 100);
}

export function cpuPercent(metrics: Pick<HostStatusMetrics, "cpuUtilization">): number | null {
  return metrics.cpuUtilization === null ? null : clampPercent(metrics.cpuUtilization * 100);
}

export function memoryPercent(
  metrics: Pick<HostStatusMetrics, "availableMemoryBytes" | "totalMemoryBytes">,
): number | null {
  return usedPercent(metrics.availableMemoryBytes, metrics.totalMemoryBytes);
}

export function diskPercent(metrics: Pick<HostStatusMetrics, "disk">): number | null {
  return metrics.disk === null
    ? null
    : usedPercent(metrics.disk.availableBytes, metrics.disk.totalBytes);
}

/** One-minute load per core; above 1 means work is queueing for a CPU. Null where the OS has no load average. */
export function loadPerCore(
  metrics: Pick<HostStatusMetrics, "loadAvg" | "cpuCount">,
): number | null {
  if (metrics.loadAvg === null || !(metrics.cpuCount > 0)) return null;
  return metrics.loadAvg.oneMinute / metrics.cpuCount;
}
